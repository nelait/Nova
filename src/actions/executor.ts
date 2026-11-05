import type { Case, Contact, FeeSchedule, Fund, Plan, Task } from '../domain/types.ts';
import { getPath, newId, render } from '../domain/util.ts';
import type { KnowledgeBase } from '../knowledge/knowledgeBase.ts';
import type { RuleResult } from '../rules/ruleEngine.ts';
import type { RecordkeeperAdapter } from '../integrations/recordkeeper.ts';
import type { EmailGateway } from '../integrations/email.ts';

export interface ActionContext {
  task: Task;
  kase: Case;
  plan: Plan;
  /** Results of already-completed steps in the same case, keyed by step id. */
  stepResults: Record<string, unknown>;
  actor: string;
  today: Date;
}

/** The data rule expressions and step conditions can read. */
export function ruleContext(ctx: Pick<ActionContext, 'kase' | 'plan' | 'stepResults' | 'today'>): Record<string, unknown> {
  const { kase, plan } = ctx;
  return {
    plan: { id: plan.id, status: plan.status, tracPlanId: plan.tracPlanId ?? null, details: plan.details },
    request: kase.request,
    case: { id: kase.id, type: kase.type, channel: kase.channel, clientId: kase.clientId },
    steps: ctx.stepResults,
    today: ctx.today.toISOString().slice(0, 10),
    client: kase.clientId,
  };
}

/** What a step WILL do, shown to the user before anything leaves the building. */
export type PreparedAction =
  | { kind: 'rules'; result: RuleResult }
  | {
      kind: 'email';
      template: string;
      to: string[];
      cc: string[];
      subject: string;
      body: string;
      /** Facts the template puts in the email. Any rewrite (by a person or AI) must keep them. */
      requiredFacts: string[];
    }
  | { kind: 'system-update'; target: string; operation: string; payload: unknown }
  | { kind: 'manual' };

export interface Edits {
  subject?: string;
  body?: string;
}

export interface ExecutionOutcome {
  result: unknown;
  plan?: Plan; // updated plan, if the action changed it
  draftEdited?: boolean;
}

export class ActionError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

/**
 * Action execution / integration hub. `prepare` is side-effect free (it powers
 * guided actions and human review); `execute` performs the side effects through
 * the integration ports.
 */
export class ActionExecutor {
  private kb: KnowledgeBase;
  private rk: RecordkeeperAdapter;
  private email: EmailGateway;

  constructor(kb: KnowledgeBase, rk: RecordkeeperAdapter, email: EmailGateway) {
    this.kb = kb;
    this.rk = rk;
    this.email = email;
  }

  prepare(ctx: ActionContext): PreparedAction {
    const { task, kase, plan } = ctx;
    const p = task.action.params ?? {};
    switch (task.action.type) {
      case 'rules.evaluate': {
        const id = this.kb.ruleSetFor(String(p.ruleSet), kase.clientId);
        return { kind: 'rules', result: this.kb.rules.evaluate(id, ruleContext(ctx)) };
      }
      case 'email.send':
        return this.prepareEmail(ctx);
      case 'contacts.upsert':
        return {
          kind: 'system-update',
          target: plan.tracPlanId ? this.rk.name : 'Plan hub',
          operation: 'upsert contacts',
          payload: p.source === 'request' ? [kase.request.contact] : plan.details.contacts,
        };
      case 'funds.apply':
        return {
          kind: 'system-update',
          target: p.source === 'request' ? this.rk.name : 'Plan hub',
          operation: 'set fund lineup',
          payload: p.source === 'request' ? kase.request.funds : plan.details.funds,
        };
      case 'fees.apply':
        return { kind: 'system-update', target: this.rk.name, operation: 'set fee schedule', payload: kase.request.fees };
      case 'trac.installPlan':
        return { kind: 'system-update', target: this.rk.name, operation: 'install plan', payload: plan.details };
      case 'trac.terminatePlan':
        return {
          kind: 'system-update',
          target: this.rk.name,
          operation: 'terminate plan',
          payload: { tracPlanId: plan.tracPlanId, effectiveDate: kase.request.effectiveDate, successorProvider: kase.request.successorProvider },
        };
      default:
        return { kind: 'manual' };
    }
  }

  execute(ctx: ActionContext, edits?: Edits): ExecutionOutcome {
    const { task, kase, plan } = ctx;
    const key = `${kase.id}:${task.stepId}`;
    const p = task.action.params ?? {};
    const prepared = this.prepare(ctx);

    switch (task.action.type) {
      case 'rules.evaluate': {
        const r = (prepared as { result: RuleResult }).result;
        const errors = r.issues.filter((i) => i.severity === 'error').map((i) => i.message);
        if (!r.passed) throw new ActionError(`Validation failed: ${errors.length} issue(s)`, errors);
        return { result: r };
      }

      case 'email.send': {
        const draft = prepared as Extract<PreparedAction, { kind: 'email' }>;
        if (draft.to.length === 0) throw new ActionError('No recipient found for this email', [`No contact with role ${String((p.to as string[])[0])}`]);
        const subject = edits?.subject ?? draft.subject;
        const body = edits?.body ?? draft.body;
        if (/\[MISSING:/.test(subject + body)) throw new ActionError('Email still contains missing fields', [...(subject + body).matchAll(/\[MISSING:([\w.]+)\]/g)].map((m) => m[1]));
        const dropped = missingFacts(draft.requiredFacts, subject + '\n' + body);
        if (dropped.length) throw new ActionError('Email is missing required facts from the template; keep them verbatim', dropped);
        const sent = this.email.send({
          id: newId('msg'),
          caseId: kase.id,
          taskId: task.id,
          to: draft.to,
          cc: draft.cc,
          subject,
          body,
          sentAt: ctx.today.toISOString(),
          sentBy: ctx.actor,
        });
        return { result: { messageId: sent.id, to: draft.to }, draftEdited: subject !== draft.subject || body !== draft.body };
      }

      case 'contacts.upsert': {
        if (p.source !== 'request') {
          return { result: { contacts: plan.details.contacts.length } };
        }
        const contact = kase.request.contact as Contact;
        const previous = plan.details.contacts.find((c) => c.role === contact.role);
        const contacts = [...plan.details.contacts.filter((c) => c.role !== contact.role), contact];
        const next = { ...plan, details: { ...plan.details, contacts } };
        if (plan.tracPlanId) this.rk.updatePlan(plan.tracPlanId, { contacts }, key);
        return { result: { previous: previous ?? null, current: contact }, plan: next };
      }

      case 'funds.apply': {
        if (p.source !== 'request') return { result: { approvedFunds: plan.details.funds.length } };
        const funds = kase.request.funds as Fund[];
        if (plan.tracPlanId) this.rk.updatePlan(plan.tracPlanId, { funds }, key);
        return { result: { funds: funds.length }, plan: { ...plan, details: { ...plan.details, funds } } };
      }

      case 'fees.apply': {
        const fees = kase.request.fees as FeeSchedule;
        if (plan.tracPlanId) this.rk.updatePlan(plan.tracPlanId, { fees }, key);
        return { result: { fees }, plan: { ...plan, details: { ...plan.details, fees } } };
      }

      case 'trac.installPlan': {
        const rk = this.rk.installPlan(plan, key);
        return { result: { tracPlanId: rk.id, version: rk.version }, plan: { ...plan, tracPlanId: rk.id } };
      }

      case 'trac.terminatePlan': {
        if (!plan.tracPlanId) throw new ActionError('Plan has no recordkeeper id');
        const rk = this.rk.terminatePlan(
          plan.tracPlanId,
          { effectiveDate: String(kase.request.effectiveDate), successorProvider: String(kase.request.successorProvider) },
          key,
        );
        return { result: { tracPlanId: rk.id, status: rk.status } };
      }

      default:
        return { result: { manual: true } };
    }
  }

  private prepareEmail(ctx: ActionContext): PreparedAction {
    const { task, kase, plan } = ctx;
    const p = task.action.params ?? {};
    const templateName = String(p.template);
    const tpl = this.kb.template(templateName, kase.clientId);
    const byRole = (roles: unknown) =>
      ((roles as string[] | undefined) ?? []).flatMap((r) => plan.details.contacts.filter((c) => c.role === r));

    const toContacts = byRole(p.to);
    const ccContacts = byRole(p.cc);
    if (p.ccPrevious) {
      const prev = (Object.values(ctx.stepResults).find((r) => r && typeof r === 'object' && 'previous' in r) as { previous?: Contact } | undefined)?.previous;
      if (prev && !toContacts.some((c) => c.email === prev.email)) ccContacts.push(prev);
    }

    const funds = (kase.request.funds as Fund[] | undefined) ?? [];
    const renderCtx = {
      plan,
      case: kase,
      request: { ...kase.request, lineupText: funds.map((f) => `  - ${f.ticker} ${f.name}${f.qdia ? ' (default/QDIA)' : ''}`).join('\n') },
      recipient: toContacts[0] ?? { name: 'Plan Sponsor' },
      fees: p.useRequestFees ? kase.request.fees : plan.details.fees,
      steps: ctx.stepResults,
    };
    return {
      kind: 'email',
      template: tpl.name,
      to: toContacts.map((c) => c.email),
      cc: ccContacts.map((c) => c.email),
      subject: render(tpl.subject, renderCtx),
      body: render(tpl.body, renderCtx),
      requiredFacts: requiredFacts(tpl.subject + '\n' + tpl.body, renderCtx, funds),
    };
  }
}

/**
 * The values a template substitutes into an email (amounts, dates, names, ids).
 * Greetings are excluded so a rewrite may address the recipient differently;
 * a fund lineup contributes its tickers.
 */
export function requiredFacts(template: string, ctx: unknown, funds: Fund[]): string[] {
  const facts = new Set<string>();
  for (const [, path] of template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    if (path.startsWith('recipient.')) continue;
    if (path === 'request.lineupText') {
      funds.forEach((f) => facts.add(f.ticker));
      continue;
    }
    const v = getPath(ctx, path);
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') facts.add(String(v).trim());
  }
  return [...facts];
}

/** Facts not present in the text. Thousands separators are ignored ("4916.44" matches "4,916.44"). */
export function missingFacts(facts: string[], text: string): string[] {
  const norm = (x: string) => x.replace(/(\d),(?=\d{3})/g, '$1').toLowerCase();
  const hay = norm(text);
  return facts.filter((f) => !hay.includes(norm(f)));
}

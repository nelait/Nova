import type { Mode, PlaybookStep, Task } from '../domain/types.ts';
import type { ActionContext, ActionExecutor, PreparedAction } from '../actions/executor.ts';
import type { KnowledgeBase } from '../knowledge/knowledgeBase.ts';

export interface GuidedAction {
  taskId: string;
  headline: string;
  mode: Mode;
  modeExplanation: string;
  guidance: string;
  checklist: string[];
  regulatoryRef?: string;
  /** Pre-built work product: drafted email, payload to send, calculation, check result. */
  prepared?: PreparedAction;
  prepareError?: string;
  /** Things the assistant noticed that the user should look at. */
  alerts: string[];
  exception?: string;
  allowedActions: ('approve' | 'confirm' | 'retry' | 'override' | 'reassign')[];
}

/**
 * Optional enrichment hook, e.g. an LLM that reads the knowledge base and the case
 * and adds advisory notes or a better-written draft. It can only add alerts or
 * replace draft text; it cannot change which steps run or how they are executed.
 */
export interface GuidanceEnricher {
  enrich(action: GuidedAction, ctx: ActionContext): GuidedAction;
}

const MODE_TEXT: Record<Mode, string> = {
  AUTO: 'Runs automatically. You are seeing it because the automation failed.',
  REVIEW: 'Prepared for you. Check it, edit if needed, then approve to execute.',
  MANUAL: 'Needs a person. Complete the checklist and confirm.',
};

export class GuidanceService {
  private kb: KnowledgeBase;
  private exec: ActionExecutor;
  private enrichers: GuidanceEnricher[];

  constructor(kb: KnowledgeBase, exec: ActionExecutor, enrichers: GuidanceEnricher[] = []) {
    this.kb = kb;
    this.exec = exec;
    this.enrichers = enrichers;
  }

  forTask(ctx: ActionContext): GuidedAction {
    const { task, kase } = ctx;
    const step: PlaybookStep | undefined = this.kb.playbookFor(kase.type, kase.clientId).steps.find((s) => s.id === task.stepId);

    let prepared: PreparedAction | undefined;
    let prepareError: string | undefined;
    try {
      prepared = this.exec.prepare(ctx);
    } catch (e) {
      prepareError = (e as Error).message;
    }

    const action: GuidedAction = {
      taskId: task.id,
      headline: `${task.name} — ${ctx.plan.details.sponsorName}`,
      mode: task.mode,
      modeExplanation: MODE_TEXT[task.mode],
      guidance: step?.guidance ?? '',
      checklist: step?.checklist ?? [],
      regulatoryRef: step?.regulatoryRef,
      prepared,
      prepareError,
      alerts: alertsFor(task, prepared, ctx),
      exception: task.exception,
      allowedActions: allowed(task),
    };
    return this.enrichers.reduce((a, e) => e.enrich(a, ctx), action);
  }
}

function allowed(task: Task): GuidedAction['allowedActions'] {
  if (task.exception) return ['retry', 'override', 'reassign'];
  if (task.mode === 'MANUAL' && task.action.type === 'none') return ['confirm', 'reassign'];
  return ['approve', 'reassign'];
}

/** Deterministic "second pair of eyes" checks. */
function alertsFor(task: Task, prepared: PreparedAction | undefined, ctx: ActionContext): string[] {
  const alerts: string[] = [];
  if (task.dueAt && task.dueAt < ctx.today.toISOString()) alerts.push(`Past SLA (was due ${task.dueAt.slice(0, 16).replace('T', ' ')})`);
  if (prepared?.kind === 'email') {
    const missing = [...(prepared.subject + prepared.body).matchAll(/\[MISSING:([\w.]+)\]/g)].map((m) => m[1]);
    if (missing.length) alerts.push(`Draft has missing fields: ${[...new Set(missing)].join(', ')}`);
    if (prepared.to.length === 0) alerts.push('No recipient: the plan has no contact for the required role');
  }
  if (ctx.kase.type === 'TERMINATION' && ctx.kase.request.blackoutStart) {
    const days = Math.floor((new Date(String(ctx.kase.request.blackoutStart)).getTime() - ctx.today.getTime()) / 86_400_000);
    if (days < 30 && task.stepId === 'blackout-notice') alerts.push(`Blackout starts in ${days} days; the notice must be given at least 30 days before`);
  }
  return alerts;
}

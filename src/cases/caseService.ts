import type { AuditEvent, Case, Plan, PlanDetails, Task, User } from '../domain/types.ts';
import { addHours, newId, type Clock } from '../domain/util.ts';
import { Collection, ValidationError } from '../store/db.ts';
import type { KnowledgeBase } from '../knowledge/knowledgeBase.ts';
import { normalizeIntake, type IntakeSubmission } from '../intake/intake.ts';
import { ActionError, ruleContext, type ActionContext, type ActionExecutor, type Edits } from '../actions/executor.ts';
import { compile } from '../rules/expression.ts';
import { STEP_CONDITION_ROOTS } from '../rules/ruleEngine.ts';
import type { IntegrationClient } from '../integrations/client.ts';
import { routeTask } from '../routing/skillRouter.ts';
import type { UserDirectory } from '../users/userDirectory.ts';

export interface Repos {
  plans: Collection<Plan>;
  cases: Collection<Case>;
  tasks: Collection<Task>;
  audit: Collection<AuditEvent>;
}

export interface CompleteInput {
  edits?: Edits;
  notes?: string;
  /** Only for steps in exception: accept the step as done without re-running it. Requires notes. */
  override?: boolean;
  /** Which draft the user started from when editing an email. */
  draftSource?: 'template' | 'ai';
}

/**
 * Rule, integration and agent results are large (outputs, trace, response data);
 * the audit log keeps a summary. The task keeps the full result.
 */
function auditSummary(result: unknown): unknown {
  if (result && typeof result === 'object' && 'agent' in result && 'proposedOutput' in result) {
    const r = result as unknown as { agent: string; version: number; edited: boolean; source: string; servedBy: string | null };
    return { agent: `${r.agent}@v${r.version}`, source: r.source, edited: r.edited, servedBy: r.servedBy };
  }
  if (result && typeof result === 'object' && 'callId' in result && 'system' in result) {
    const r = result as { system: string; operation: string; status: number; attempts: number; callId: string };
    return { call: `${r.system}.${r.operation}`, status: r.status, attempts: r.attempts, callId: r.callId };
  }
  if (result && typeof result === 'object' && 'ruleSet' in result && 'issues' in result) {
    const r = result as { ruleSet: string; version: number; passed: boolean; issues: { ruleId: string; severity: string }[] };
    return { ruleSet: `${r.ruleSet}@v${r.version}`, passed: r.passed, issues: r.issues.map((i) => `${i.severity}:${i.ruleId}`) };
  }
  return result;
}

export type DraftLookup = (taskId: string) => { subject: string; body: string } | undefined;

const OPEN: Task['status'][] = ['READY', 'IN_PROGRESS'];

/**
 * The case & work item engine. A case is one business request against one plan
 * (installation, a maintenance change, a termination). It expands into tasks from
 * the playbook; tasks unblock as their dependencies finish; AUTO tasks run
 * immediately, REVIEW/MANUAL tasks (and failed AUTO tasks) go to people via the
 * skill router. When every task is done the case completes.
 */
export class CaseService {
  private r: Repos;
  private kb: KnowledgeBase;
  private exec: ActionExecutor;
  private integrations: IntegrationClient;
  private users: UserDirectory;
  private clock: Clock;
  private aiDraftFor?: DraftLookup;
  private locks = new Map<string, Promise<unknown>>();

  constructor(r: Repos, kb: KnowledgeBase, exec: ActionExecutor, integrations: IntegrationClient, users: UserDirectory, clock: Clock) {
    this.r = r;
    this.kb = kb;
    this.exec = exec;
    this.integrations = integrations;
    this.users = users;
    this.clock = clock;
  }

  /**
   * Steps can now wait on external systems, so two requests could interleave on
   * one case. Work on a case runs one at a time.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  get repos(): Repos {
    return this.r;
  }

  /** Lets the engine measure edits against Claude's draft when the user started from it. */
  setAiDraftLookup(fn: DraftLookup): void {
    this.aiDraftFor = fn;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  audit(actor: string, entity: AuditEvent['entity'], entityId: string, event: string, detail?: unknown, caseId?: string): void {
    this.r.audit.insert({ id: newId('evt'), at: this.now(), actor, entity, entityId, caseId, event, detail });
  }

  // ---------------------------------------------------------------- intake

  async submitIntake(sub: IntakeSubmission, actor: string): Promise<{ case: Case; tasks: Task[] }> {
    const n = normalizeIntake(sub);
    let plan: Plan;

    if (n.caseType === 'INSTALLATION') {
      plan = {
        id: newId('plan'),
        clientId: n.clientId,
        status: 'ONBOARDING',
        details: n.planDetails!,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.r.plans.insert(plan);
      this.audit(actor, 'plan', plan.id, 'plan.created', { channel: n.channel });
    } else {
      plan = this.r.plans.require(n.planId!);
      if (plan.status !== 'ACTIVE' || !plan.tracPlanId) {
        throw new ValidationError(`Plan ${plan.id} is ${plan.status}; ${n.caseType} requires an installed, active plan`);
      }
      const openCases = this.r.cases.find((c) => c.planId === plan.id && c.status === 'OPEN');
      if (n.caseType === 'TERMINATION' && openCases.length) {
        throw new ValidationError(`Plan has ${openCases.length} open case(s); finish or cancel them before terminating`);
      }
      // The recordkeeper is the system of record once a plan is live: refresh our snapshot first.
      plan = await this.refreshFromRecordkeeper(plan, actor);
      if (n.caseType === 'TERMINATION') {
        plan = this.r.plans.update({ ...plan, status: 'TERMINATING', updatedAt: this.now() });
      }
    }

    const pb = this.kb.playbookFor(n.caseType, plan.clientId);
    const kase: Case = {
      id: newId('case'),
      planId: plan.id,
      clientId: plan.clientId,
      type: n.caseType,
      channel: n.channel,
      status: 'OPEN',
      request: n.request,
      playbookId: pb.id,
      playbookVersion: pb.version,
      createdAt: this.now(),
    };
    this.r.cases.insert(kase);
    this.audit(actor, 'case', kase.id, 'case.opened', { type: kase.type, channel: kase.channel, playbook: `${pb.id}@v${pb.version}` }, kase.id);

    for (const step of pb.steps) {
      this.r.tasks.insert({
        id: newId('task'),
        caseId: kase.id,
        planId: plan.id,
        stepId: step.id,
        name: step.name,
        skill: step.skill,
        minSkillLevel: step.minSkillLevel ?? 1,
        mode: step.mode,
        action: step.action,
        dependsOn: step.dependsOn ?? [],
        status: 'BLOCKED',
        createdAt: this.now(),
        history: [{ at: this.now(), by: 'system', event: 'created' }],
      });
    }
    await this.advance(kase.id);
    return { case: this.r.cases.require(kase.id), tasks: this.tasksFor(kase.id) };
  }

  async refreshFromRecordkeeper(plan: Plan, actor = 'system'): Promise<Plan> {
    if (!plan.tracPlanId) return plan;
    const { data } = await this.integrations.call('trac', 'getPlan', {
      context: { plan: { id: plan.id, tracPlanId: plan.tracPlanId, details: plan.details } },
      actor,
    });
    const rk = data as { contacts: PlanDetails['contacts']; funds: PlanDetails['funds']; fees: PlanDetails['fees']; participantCount: number; planAssetsUsd: number };
    const details: PlanDetails = {
      ...plan.details,
      contacts: rk.contacts,
      funds: rk.funds,
      fees: rk.fees,
      employeeCount: rk.participantCount,
      planAssetsUsd: rk.planAssetsUsd,
    };
    return this.r.plans.update({ ...plan, details, updatedAt: this.now() });
  }

  /** Correct onboarding data. Only allowed before the plan is on the recordkeeper. */
  updatePlanDetails(planId: string, patch: Partial<PlanDetails>, actor: string): Plan {
    const plan = this.r.plans.require(planId);
    if (plan.tracPlanId) throw new ValidationError('Plan is live on the recordkeeper; submit a maintenance request instead');
    const next = this.r.plans.update({ ...plan, details: { ...plan.details, ...patch }, updatedAt: this.now() });
    this.audit(actor, 'plan', planId, 'plan.corrected', { fields: Object.keys(patch) });
    return next;
  }

  // ---------------------------------------------------------------- engine

  /** Unblock tasks whose dependencies are done, run AUTO tasks, route human tasks, close the case. */
  advance(caseId: string): Promise<void> {
    return this.withLock(caseId, () => this.advanceUnlocked(caseId));
  }

  private async advanceUnlocked(caseId: string): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const tasks = this.tasksFor(caseId);
      const doneSteps = new Set(tasks.filter((t) => t.status === 'DONE' || t.status === 'SKIPPED').map((t) => t.stepId));
      let progressed = false;

      for (const t of tasks.filter((t) => t.status === 'BLOCKED' && t.dependsOn.every((d) => doneSteps.has(d)))) {
        const step = this.kb.playbookFor(this.r.cases.require(caseId).type, this.r.cases.require(caseId).clientId).steps.find((s) => s.id === t.stepId);
        progressed = true;
        if (step?.when) {
          let applies: boolean;
          try {
            applies = compile(step.when, STEP_CONDITION_ROOTS).test(ruleContext(this.contextFor(t, 'system')));
          } catch (e) {
            // A broken condition must not silently skip or run a step: a person decides.
            this.save(t, { status: 'READY', readyAt: this.now(), exception: `Step condition could not be evaluated: ${(e as Error).message}` }, 'system', 'condition-failed');
            continue;
          }
          if (!applies) {
            this.save(t, { status: 'SKIPPED', completedAt: this.now() }, 'system', 'skipped', { condition: step.when });
            continue;
          }
        }
        this.save(t, { status: 'READY', readyAt: this.now(), dueAt: step?.slaHours ? addHours(this.now(), step.slaHours) : undefined }, 'system', 'ready');
      }

      for (const t of this.tasksFor(caseId).filter((t) => t.status === 'READY' && t.mode === 'AUTO' && !t.exception)) {
        await this.runAuto(t);
        progressed = true;
      }

      // AI agent steps: produce a proposal as soon as the step is ready, so the reviewer starts from it.
      for (const t of this.tasksFor(caseId).filter((t) => t.status === 'READY' && t.action.type === 'ai.agent' && !t.proposal && !t.exception)) {
        await this.runAgent(t);
      }
      if (!progressed) break;
    }
    this.routeUnassigned(); // global: finished work may have freed capacity for other cases
    this.checkCompletion(caseId);
  }

  private async runAuto(task: Task): Promise<void> {
    try {
      const outcome = await this.exec.execute(this.contextFor(task, 'system'));
      if (outcome.plan) this.r.plans.update({ ...outcome.plan, updatedAt: this.now() });
      this.save(task, { status: 'DONE', result: outcome.result, completedAt: this.now() }, 'system', 'auto-completed', auditSummary(outcome.result));
    } catch (e) {
      const issues = e instanceof ActionError ? e.issues : [];
      // Automation failed: hand the step to a person instead of stalling the case.
      this.save(task, { exception: `${(e as Error).message}${issues.length ? `: ${issues.join('; ')}` : ''}` }, 'system', 'auto-failed', { issues });
    }
  }

  private async runAgent(task: Task, actor = 'system'): Promise<Task> {
    try {
      const proposal = await this.exec.runAgent(this.contextFor(task, actor));
      return this.save(task, { proposal, exception: undefined }, `agent:${proposal.agent}`, 'agent-proposed', {
        servedBy: proposal.servedBy,
        toolCalls: proposal.toolCalls.map((c) => `${c.tool}${c.ok ? '' : ' (failed)'}`),
        usage: proposal.usage,
        schemaIssues: proposal.schemaIssues,
      });
    } catch (e) {
      return this.save(task, { proposal: undefined, exception: `AI agent could not produce a proposal: ${(e as Error).message}` }, actor, 'agent-failed');
    }
  }

  /** Ask the agent for a new proposal (e.g. after it failed, or the data changed). */
  rerunAgent(taskId: string, userId: string): Promise<Task> {
    const t0 = this.r.tasks.require(taskId);
    return this.withLock(t0.caseId, async () => {
      const t = this.r.tasks.require(taskId);
      this.requireOwner(t, userId);
      if (t.action.type !== 'ai.agent') throw new ValidationError('This step does not run an AI agent');
      return this.runAgent({ ...t, proposal: undefined }, userId);
    });
  }

  private needsHuman(t: Task): boolean {
    return t.mode !== 'AUTO' || !!t.exception;
  }

  openLoad(): Map<string, number> {
    const load = new Map<string, number>();
    for (const t of this.r.tasks.find((t) => OPEN.includes(t.status) && !!t.assigneeId)) {
      load.set(t.assigneeId!, (load.get(t.assigneeId!) ?? 0) + 1);
    }
    return load;
  }

  /**
   * Order of each user's most recent assignment (higher = more recent), from the
   * audit log, which is strictly ordered even when timestamps are equal. The
   * router uses it to rotate work between equally loaded people.
   */
  lastAssigned(): Map<string, number> {
    const last = new Map<string, number>();
    this.r.audit.all().forEach((e, i) => {
      const to = (e.detail as { to?: string } | undefined)?.to;
      if ((e.event === 'task.assigned' || e.event === 'task.reassigned') && to) last.set(to, i);
    });
    return last;
  }

  /** Route every ready human task that has no owner (optionally only for one case). */
  routeUnassigned(caseId?: string): number {
    let routed = 0;
    const users = this.users.list();
    const pending = this.r.tasks.find((t) => t.status === 'READY' && !t.assigneeId && this.needsHuman(t) && (!caseId || t.caseId === caseId));
    for (const t of pending) {
      const decision = routeTask(t, users, this.openLoad(), [], this.lastAssigned());
      if (decision.assigneeId) {
        this.save(t, { assigneeId: decision.assigneeId }, 'router', 'assigned', { to: decision.assigneeId, reason: decision.reason });
        routed++;
      } else if (!t.history.some((h) => h.event === 'queued' && (h.detail as { reason?: string })?.reason === decision.reason)) {
        this.save(t, {}, 'router', 'queued', { reason: decision.reason });
      }
    }
    return routed;
  }

  private checkCompletion(caseId: string): void {
    const kase = this.r.cases.require(caseId);
    if (kase.status !== 'OPEN') return;
    const tasks = this.tasksFor(caseId);
    if (!tasks.every((t) => t.status === 'DONE' || t.status === 'SKIPPED')) return;
    this.r.cases.update({ ...kase, status: 'COMPLETED', completedAt: this.now() });
    const plan = this.r.plans.require(kase.planId);
    if (kase.type === 'INSTALLATION') {
      this.r.plans.update({ ...plan, status: 'ACTIVE', updatedAt: this.now() });
      this.audit('system', 'plan', plan.id, 'plan.installation-complete', { tracPlanId: this.r.plans.require(plan.id).tracPlanId }, caseId);
    }
    if (kase.type === 'TERMINATION') {
      this.r.plans.update({ ...plan, status: 'TERMINATED', updatedAt: this.now() });
      this.audit('system', 'plan', plan.id, 'plan.terminated', undefined, caseId);
    }
    this.audit('system', 'case', caseId, 'case.completed', undefined, caseId);
  }

  // ---------------------------------------------------------------- user actions

  private requireOwner(task: Task, userId: string): void {
    if (task.assigneeId !== userId) throw new ValidationError(`Task ${task.id} is assigned to ${task.assigneeId ?? 'nobody'}, not ${userId}`);
    if (!OPEN.includes(task.status)) throw new ValidationError(`Task ${task.id} is ${task.status}`);
  }

  startTask(taskId: string, userId: string): Task {
    const t = this.r.tasks.require(taskId);
    this.requireOwner(t, userId);
    if (t.status === 'IN_PROGRESS') return t;
    return this.save(t, { status: 'IN_PROGRESS', startedAt: this.now() }, userId, 'started');
  }

  /** Approve/execute a REVIEW step, confirm a MANUAL step, or resolve an exception. */
  completeTask(taskId: string, userId: string, input: CompleteInput = {}): Promise<Task> {
    const caseId = this.r.tasks.require(taskId).caseId;
    return this.withLock(caseId, () => this.completeUnlocked(taskId, userId, input));
  }

  private async completeUnlocked(taskId: string, userId: string, input: CompleteInput): Promise<Task> {
    let t = this.r.tasks.require(taskId);
    this.requireOwner(t, userId);
    if (t.status === 'READY') t = this.startTask(taskId, userId);

    if (input.override) {
      if (!t.exception) throw new ValidationError('Override is only for steps in exception');
      if (!input.notes?.trim()) throw new ValidationError('Override requires a justification in notes');
      t = this.save(t, { status: 'DONE', completedAt: this.now(), result: { overridden: true, notes: input.notes } }, userId, 'overridden', { notes: input.notes, exception: t.exception });
    } else if (t.action.type === 'ai.agent' && t.exception && input.edits?.output === undefined) {
      // "Retry" on a failed agent step runs the agent again; the step stays open for review.
      return this.runAgent({ ...t, proposal: undefined }, userId);
    } else if (t.mode === 'MANUAL' && t.action.type === 'none') {
      t = this.save(t, { status: 'DONE', completedAt: this.now(), result: { notes: input.notes ?? '' } }, userId, 'confirmed', { notes: input.notes });
    } else {
      try {
        const outcome = await this.exec.execute(this.contextFor(t, userId), input.edits);
        if (outcome.plan) this.r.plans.update({ ...outcome.plan, updatedAt: this.now() });
        let draftEdited = outcome.draftEdited;
        let draftSource: Task['draftSource'];
        if (outcome.draftSource) {
          draftSource = outcome.draftSource;
        } else if (draftEdited !== undefined) {
          const ai = input.draftSource === 'ai' ? this.aiDraftFor?.(t.id) : undefined;
          draftSource = ai ? 'ai' : 'template';
          if (ai) draftEdited = (input.edits?.subject ?? '') !== ai.subject || (input.edits?.body ?? '') !== ai.body;
        }
        t = this.save(
          t,
          { status: 'DONE', completedAt: this.now(), result: outcome.result, draftEdited, draftSource, exception: undefined },
          userId,
          'executed',
          { result: auditSummary(outcome.result), draftEdited, draftSource, notes: input.notes },
        );
      } catch (e) {
        const issues = e instanceof ActionError ? e.issues : [];
        this.save(t, { exception: `${(e as Error).message}${issues.length ? `: ${issues.join('; ')}` : ''}` }, userId, 'execution-failed', { issues });
        throw e instanceof ActionError ? e : new ActionError((e as Error).message);
      }
    }
    await this.advanceUnlocked(t.caseId);
    return this.r.tasks.require(taskId);
  }

  /** Move a task to a specific user, or back through the router (excluding the current owner). */
  reassign(taskId: string, by: string, toUserId?: string): Task {
    const t = this.r.tasks.require(taskId);
    if (!OPEN.includes(t.status)) throw new ValidationError(`Task ${taskId} is ${t.status}`);
    let target = toUserId;
    if (target) {
      const u = this.users.get(target);
      if (!u?.active) throw new ValidationError(`User ${target} is not active`);
      if (!u.skills.some((s) => s.skill === t.skill && s.level >= t.minSkillLevel)) throw new ValidationError(`${u.name} lacks ${t.skill} L${t.minSkillLevel}`);
    } else {
      target = routeTask(t, this.users.list(), this.openLoad(), t.assigneeId ? [t.assigneeId] : [], this.lastAssigned()).assigneeId;
    }
    return this.save(t, { assigneeId: target, status: 'READY', startedAt: undefined }, by, 'reassigned', { from: t.assigneeId, to: target ?? null });
  }

  cancelCase(caseId: string, by: string, reason: string): Case {
    const kase = this.r.cases.require(caseId);
    if (kase.status !== 'OPEN') throw new ValidationError(`Case is ${kase.status}`);
    for (const t of this.tasksFor(caseId).filter((t) => t.status !== 'DONE')) this.save(t, { status: 'SKIPPED' }, by, 'cancelled');
    const next = this.r.cases.update({ ...kase, status: 'CANCELLED', completedAt: this.now() });
    const plan = this.r.plans.require(kase.planId);
    if (kase.type === 'TERMINATION' && plan.status === 'TERMINATING') this.r.plans.update({ ...plan, status: 'ACTIVE' });
    this.audit(by, 'case', caseId, 'case.cancelled', { reason }, caseId);
    return next;
  }

  // ---------------------------------------------------------------- queries

  tasksFor(caseId: string): Task[] {
    return this.r.tasks.find((t) => t.caseId === caseId);
  }

  inbox(userId: string): Task[] {
    return this.r.tasks
      .find((t) => t.assigneeId === userId && OPEN.includes(t.status))
      .sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'));
  }

  unassignedQueue(): Task[] {
    return this.r.tasks.find((t) => t.status === 'READY' && !t.assigneeId && this.needsHuman(t));
  }

  /** The data rules see for a case right now (completed step results included). */
  ruleContextForCase(caseId: string): Record<string, unknown> {
    const kase = this.r.cases.require(caseId);
    const stepResults: Record<string, unknown> = {};
    for (const t of this.tasksFor(caseId)) if (t.status === 'DONE') stepResults[t.stepId] = t.result;
    return ruleContext({ kase, plan: this.r.plans.require(kase.planId), stepResults, today: this.clock.now() });
  }

  contextFor(task: Task, actor: string): ActionContext {
    const kase = this.r.cases.require(task.caseId);
    const stepResults: Record<string, unknown> = {};
    for (const t of this.tasksFor(task.caseId)) if (t.status === 'DONE') stepResults[t.stepId] = t.result;
    return { task, kase, plan: this.r.plans.require(task.planId), stepResults, actor, today: this.clock.now() };
  }

  private save(task: Task, patch: Partial<Task>, by: string, event: string, detail?: unknown): Task {
    const next: Task = { ...task, ...patch, history: [...task.history, { at: this.now(), by, event, detail }] };
    this.r.tasks.update(next);
    this.audit(by, 'task', task.id, `task.${event}`, { step: task.stepId, ...(detail && typeof detail === 'object' ? detail : {}) }, task.caseId);
    return next;
  }

  allUsers(): User[] {
    return this.users.list();
  }
}

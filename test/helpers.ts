import { createApp, type App } from '../src/app.ts';
import type { PlanDetails } from '../src/domain/types.ts';
import type { ModelCall } from '../src/ai/claudeAssist.ts';
import type { AgentModel } from '../src/ai/agents.ts';

export const NOW = new Date('2026-11-05T15:00:00Z');

export function testApp(aiModel: ModelCall | null = null, agentModel: AgentModel | null = null): App & { tick: (hours: number) => void } {
  let now = NOW.getTime();
  // Retries don't wait in tests; integrations use the built-in mock systems.
  const app = createApp({ dbPath: ':memory:', seedUsers: true, clock: { now: () => new Date(now) }, aiModel, agentModel, env: {}, sleep: async () => {} });
  return Object.assign(app, { tick: (h: number) => void (now += h * 3600_000) });
}

/**
 * Adds a COMPLIANCE level-1 trainee. The seed team has none, so tests that prove
 * level-2 work never reaches a trainee add one explicitly.
 */
export function addComplianceTrainee(app: App): string {
  app.users.importScim([{ id: 'trainee', userName: 'tia@planops.example', displayName: 'Tia Trainee', groups: [{ display: 'skill:COMPLIANCE:1' }] }], 'test');
  return 'u_trainee';
}

export function sampleDetails(overrides: Partial<PlanDetails> = {}): PlanDetails {
  return {
    sponsorName: 'Acme Robotics Inc.',
    ein: '12-3456789',
    employeeCount: 250,
    planType: '401K',
    effectiveDate: '2027-01-01',
    planAssetsUsd: 12_000_000,
    contacts: [
      { role: 'PLAN_ADMINISTRATOR', name: 'Jane Doe', email: 'jane.doe@acme.example' },
      { role: 'PAYROLL', name: 'Raj Patel', email: 'payroll@acme.example' },
      { role: 'TRUSTEE', name: 'Lee Wong', email: 'trustee@acme.example' },
    ],
    funds: [
      { ticker: 'VFIAX', name: 'Vanguard 500 Index Admiral' },
      { ticker: 'VBTLX', name: 'Vanguard Total Bond Market Index Admiral' },
      { ticker: 'VTTSX', name: 'Vanguard Target Retirement 2060', qdia: true },
    ],
    fees: { recordkeepingBps: 8, perParticipantUsd: 40, terminationBaseUsd: 2500 },
    ...overrides,
  };
}

/** Complete every open human task in the case by its assignee until nothing is left. */
type Draft = { subject: string; body: string };
export async function workCase(
  app: App,
  caseId: string,
  opts: { edits?: (stepId: string, draft: Draft | undefined) => Partial<Draft> | undefined } = {},
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const open = app.cases.tasksFor(caseId).filter((t) => (t.status === 'READY' || t.status === 'IN_PROGRESS') && t.assigneeId);
    if (open.length === 0) return;
    for (const t of open) {
      app.cases.startTask(t.id, t.assigneeId!);
      const prepared = app.guidance.forTask(app.cases.contextFor(t, t.assigneeId!)).prepared;
      const draft = prepared?.kind === 'email' ? { subject: prepared.subject, body: prepared.body } : undefined;
      await app.cases.completeTask(t.id, t.assigneeId!, { notes: 'ok', edits: opts.edits?.(t.stepId, draft) });
    }
  }
  throw new Error('workCase did not converge');
}

export async function installPlan(app: App, clientId = 'default', details = sampleDetails()) {
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', clientId, data: { details } }, 'portal');
  await workCase(app, kase.id);
  return { kase: app.repos.cases.require(kase.id), plan: app.repos.plans.require(kase.planId) };
}

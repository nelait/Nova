import { createApp, type App } from '../src/app.ts';
import type { PlanDetails } from '../src/domain/types.ts';

export const NOW = new Date('2026-11-05T15:00:00Z');

export function testApp(): App & { tick: (hours: number) => void } {
  let now = NOW.getTime();
  const app = createApp({ dbPath: ':memory:', seedUsers: true, clock: { now: () => new Date(now) } });
  return Object.assign(app, { tick: (h: number) => void (now += h * 3600_000) });
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
export function workCase(app: App, caseId: string, opts: { edits?: (stepId: string) => { subject?: string; body?: string } | undefined } = {}): void {
  for (let i = 0; i < 50; i++) {
    const open = app.cases.tasksFor(caseId).filter((t) => (t.status === 'READY' || t.status === 'IN_PROGRESS') && t.assigneeId);
    if (open.length === 0) return;
    for (const t of open) {
      app.cases.startTask(t.id, t.assigneeId!);
      app.cases.completeTask(t.id, t.assigneeId!, { notes: 'ok', edits: opts.edits?.(t.stepId) });
    }
  }
  throw new Error('workCase did not converge');
}

export function installPlan(app: App, clientId = 'default', details = sampleDetails()) {
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', clientId, data: { details } }, 'portal');
  workCase(app, kase.id);
  return { kase: app.repos.cases.require(kase.id), plan: app.repos.plans.require(kase.planId) };
}

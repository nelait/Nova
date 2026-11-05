import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPlan, sampleDetails, testApp, workCase } from './helpers.ts';
import { routeTask } from '../src/routing/skillRouter.ts';
import { validatePlaybook } from '../src/knowledge/knowledgeBase.ts';
import type { Task, User } from '../src/domain/types.ts';

test('client customization: added step, mode override and template override', () => {
  const app = testApp();
  const { case: kase, tasks } = app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', clientId: 'acme-premium', data: { details: sampleDetails() } },
    'portal',
  );
  assert.ok(tasks.some((t) => t.stepId === 'kickoff-call'));
  assert.equal(tasks.find((t) => t.stepId === 'welcome-email')!.mode, 'AUTO');
  workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  assert.ok(app.email.list().some((m) => m.subject.startsWith('Welcome aboard')), 'client template used');
});

test('router: queues when nobody has the skill, then routes after users are imported from the IdP', () => {
  const app = testApp();
  app.users.setActive('u_sam', false); // only INVESTMENTS user
  const { tasks } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const fund = tasks.find((t) => t.stepId === 'review-fund-lineup')!;
  assert.equal(fund.assigneeId, undefined);
  assert.equal(app.cases.unassignedQueue().length, 1);
  assert.equal(app.insights().backlogBySkill.INVESTMENTS, 1);

  app.users.importScim(
    [{ id: '900', userName: 'kai@planops.example', displayName: 'Kai Brown', groups: [{ display: 'skill:INVESTMENTS:2' }] }],
    'okta',
  );
  assert.equal(app.cases.routeUnassigned(), 1);
  assert.equal(app.repos.tasks.require(fund.id).assigneeId, 'u_900');
});

test('router: respects capacity and spreads load', () => {
  const users: User[] = [
    { id: 'a', name: 'A', email: '', active: true, capacity: 2, skills: [{ skill: 'X', level: 2 }], source: 't' },
    { id: 'b', name: 'B', email: '', active: true, capacity: 4, skills: [{ skill: 'X', level: 2 }], source: 't' },
  ];
  const task = { skill: 'X', minSkillLevel: 1 } as Task;
  assert.equal(routeTask(task, users, new Map([['a', 1], ['b', 1]])).assigneeId, 'b'); // 1/4 < 1/2
  assert.equal(routeTask(task, users, new Map([['a', 0], ['b', 4]])).assigneeId, 'a');
  assert.equal(routeTask(task, users, new Map([['a', 2], ['b', 4]])).assigneeId, undefined);
});

test('reassign: explicit target must hold the skill; auto reassign excludes current owner', () => {
  const app = testApp();
  const { tasks } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const verify = tasks.find((t) => t.stepId === 'verify-sponsor')!;
  assert.throws(() => app.cases.reassign(verify.id, 'lead', 'u_priya'), /lacks COMPLIANCE/);
  const moved = app.cases.reassign(verify.id, 'lead');
  assert.equal(moved.assigneeId, 'u_sam'); // only other COMPLIANCE holder
});

test('TRAC outage: install step goes to exception; retry is idempotent', () => {
  const app = testApp();
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const all = () => Object.fromEntries(app.cases.tasksFor(kase.id).map((t) => [t.stepId, t]));
  for (const step of ['verify-sponsor', 'review-fund-lineup', 'fee-disclosure', 'welcome-email']) {
    const t = all()[step];
    app.cases.completeTask(t.id, t.assigneeId!);
  }
  const install = all()['trac-install'];
  app.trac.failNextWith = 'timeout';
  assert.throws(() => app.cases.completeTask(install.id, install.assigneeId!), /TRAC unavailable/);
  assert.match(app.repos.tasks.require(install.id).exception!, /timeout/);

  assert.equal(app.cases.completeTask(install.id, install.assigneeId!).status, 'DONE');
  assert.throws(() => app.cases.completeTask(install.id, install.assigneeId!), /is DONE/);
  assert.equal(app.trac.listPlans().length, 1);
  workCase(app, kase.id); // remaining work, e.g. enrollment meetings for a 250-person plan
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
});

test('edited drafts are recorded and override requires justification', () => {
  const app = testApp();
  const { tasks } = app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: 'bad' }) } },
    'portal',
  );
  const v = tasks.find((t) => t.stepId === 'validate-intake')!;
  assert.throws(() => app.cases.completeTask(v.id, v.assigneeId!, { override: true }), /justification/);
  const ok = app.cases.completeTask(v.id, v.assigneeId!, { override: true, notes: 'EIN confirmed by phone; form typo' });
  assert.equal(ok.status, 'DONE');
  assert.ok(app.repos.audit.all().some((e) => e.event === 'task.overridden'));
});

test('insights: suggests promoting a never-edited review step and fixing an often-edited template', () => {
  const app = testApp();
  for (let i = 0; i < 5; i++) {
    const { case: kase } = app.cases.submitIntake(
      { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: `12-345678${i}` }) } },
      'portal',
    );
    workCase(app, kase.id, { edits: (step, d) => (step === 'welcome-email' ? { body: d!.body + '\nP.S. Your kickoff call is next week.' } : undefined) });
  }
  const ins = app.insights();
  assert.equal(ins.cases.completed, 5);
  assert.ok(ins.suggestions.some((s) => s.kind === 'promote-to-auto' && s.target === 'INSTALLATION / fee-disclosure'));
  assert.ok(ins.suggestions.some((s) => s.kind === 'fix-template' && s.target === 'INSTALLATION / welcome-email'));
});

test('playbook validation catches unknown dependencies and cycles', () => {
  const step = (id: string, dependsOn: string[]) => ({ id, name: id, skill: 'X', mode: 'AUTO' as const, action: { type: 'none' as const }, guidance: '', dependsOn });
  assert.throws(() => validatePlaybook({ id: 'p', version: 1, caseType: 'INSTALLATION', name: '', description: '', steps: [step('a', ['zz'])] }), /unknown step/);
  assert.throws(() => validatePlaybook({ id: 'p', version: 1, caseType: 'INSTALLATION', name: '', description: '', steps: [step('a', ['b']), step('b', ['a'])] }), /cycle/);
});

test('onboarding data cannot be edited once the plan is live on TRAC', () => {
  const app = testApp();
  const { plan } = installPlan(app);
  assert.throws(() => app.cases.updatePlanDetails(plan.id, { employeeCount: 1 }, 'u_priya'), /maintenance request/);
});

test('rewritten emails must keep the facts the template put in them', () => {
  const app = testApp();
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const t = Object.fromEntries(app.cases.tasksFor(kase.id).map((x) => [x.stepId, x]));
  app.cases.completeTask(t['review-fund-lineup'].id, 'u_sam');
  const fee = app.repos.tasks.require(app.cases.tasksFor(kase.id).find((x) => x.stepId === 'fee-disclosure')!.id);
  const g = app.guidance.forTask(app.cases.contextFor(fee, fee.assigneeId!));
  assert.ok(g.prepared?.kind === 'email');
  if (g.prepared?.kind !== 'email') return;
  assert.ok(g.prepared.requiredFacts.includes('Acme Robotics Inc.'));
  assert.ok(g.prepared.requiredFacts.includes('2500'));
  // Dropping the deconversion fee is blocked...
  const body = g.prepared.body.replace(/.*Deconversion fee.*\n/, '');
  assert.throws(() => app.cases.completeTask(fee.id, fee.assigneeId!, { edits: { body } }), (e: Error & { issues?: string[] }) => e.issues?.includes('2500') === true);
  // ...but rewording that keeps every fact (with thousands separators) is fine.
  const reworded = g.prepared.body.replace('$2500', '$2,500').replace('Dear Jane Doe', 'Hello Jane');
  assert.equal(app.cases.completeTask(fee.id, fee.assigneeId!, { edits: { body: reworded } }).status, 'DONE');
});

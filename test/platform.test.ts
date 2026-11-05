import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPlan, sampleDetails, testApp, workCase, addComplianceTrainee } from './helpers.ts';
import { routeTask } from '../src/routing/skillRouter.ts';
import { validatePlaybook } from '../src/knowledge/knowledgeBase.ts';
import type { Task, User } from '../src/domain/types.ts';

test('client customization: added step, mode override and template override', async () => {
  const app = testApp();
  const { case: kase, tasks } = await app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', clientId: 'acme-premium', data: { details: sampleDetails() } },
    'portal',
  );
  assert.ok(tasks.some((t) => t.stepId === 'kickoff-call'));
  assert.equal(tasks.find((t) => t.stepId === 'welcome-email')!.mode, 'AUTO');
  await workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  assert.ok(app.email.list().some((m) => m.subject.startsWith('Welcome aboard')), 'client template used');
});

test('router: queues when nobody has the skill, then routes after users are imported from the IdP', async () => {
  const app = testApp();
  app.users.setActive('u_sam', false); // only INVESTMENTS user
  const { tasks } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const fund = tasks.find((t) => t.stepId === 'review-fund-lineup')!;
  assert.equal(fund.assigneeId, undefined);
  assert.equal(app.cases.unassignedQueue().length, 1);
  assert.equal(app.insights().backlogBySkill.INVESTMENTS, 1);

  app.users.importScim(
    [{ id: '900', userName: 'kai@planops.example', displayName: 'Kai Brown', groups: [{ display: 'skill:INVESTMENTS:2' }, { display: 'client:default' }] }],
    'okta',
  );
  assert.equal(app.cases.routeUnassigned(), 1);
  assert.equal(app.repos.tasks.require(fund.id).assigneeId, 'u_900');
});

test('router: respects capacity and spreads load', async () => {
  const users: User[] = [
    { id: 'a', name: 'A', email: '', active: true, capacity: 2, skills: [{ skill: 'X', level: 2 }], source: 't' },
    { id: 'b', name: 'B', email: '', active: true, capacity: 4, skills: [{ skill: 'X', level: 2 }], source: 't' },
  ];
  const task = { skill: 'X', minSkillLevel: 1 } as Task;
  assert.equal(routeTask(task, users, new Map([['a', 1], ['b', 1]])).assigneeId, 'b'); // 1/4 < 1/2
  assert.equal(routeTask(task, users, new Map([['a', 0], ['b', 4]])).assigneeId, 'a');
  assert.equal(routeTask(task, users, new Map([['a', 2], ['b', 4]])).assigneeId, undefined);
  // Equal load ratio: whoever was assigned least recently goes next, even if less senior.
  const equal = [
    { ...users[0], skills: [{ skill: 'X', level: 3 }], capacity: 4 },
    { ...users[1], skills: [{ skill: 'X', level: 1 }], capacity: 4 },
  ];
  const idle = new Map<string, number>();
  assert.equal(routeTask(task, equal, idle).assigneeId, 'a', 'nobody assigned yet: user id decides');
  assert.equal(routeTask(task, equal, idle, [], new Map([['a', 7]])).assigneeId, 'b', 'a had the last one');
  assert.equal(routeTask(task, equal, idle, [], new Map([['a', 7], ['b', 9]])).assigneeId, 'a');
  assert.match(routeTask(task, equal, idle).reason, /next in rotation of 2/);
});

test('reassign: target must hold the skill at the required level; auto reassign excludes current owner', async () => {
  const app = testApp();
  const { tasks } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const verify = tasks.find((t) => t.stepId === 'verify-sponsor')!;
  assert.equal(verify.assigneeId, 'u_elena');
  assert.throws(() => app.cases.reassign(verify.id, 'lead', 'u_priya'), /lacks COMPLIANCE/);
  // Sponsor verification needs COMPLIANCE level 2+: a level-1 trainee can't take it.
  const trainee = addComplianceTrainee(app);
  assert.throws(() => app.cases.reassign(verify.id, 'lead', trainee), /lacks COMPLIANCE L2/);
  // Auto reassign moves it away from the current owner, to the other level-2+ user.
  assert.equal(app.cases.reassign(verify.id, 'lead').assigneeId, 'u_rafael');
  // With no other qualified user free, it goes back to the queue rather than to a trainee.
  app.users.setActive('u_elena', false);
  assert.equal(app.cases.reassign(verify.id, 'lead').assigneeId, undefined);
  app.users.setActive('u_elena', true);
  assert.equal(app.cases.routeUnassigned(), 1);
  assert.equal(app.repos.tasks.require(verify.id).assigneeId, 'u_elena');
});

test('sponsor verification never routes to a COMPLIANCE trainee, even when others are busy', async () => {
  const app = testApp();
  addComplianceTrainee(app);
  // Enough work that load-balancing alone would reach the trainee.
  for (let i = 0; i < 4; i++) {
    await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: `12-000000${i}` }) } }, 'portal');
  }
  const verifications = app.repos.tasks.find((t) => t.stepId === 'verify-sponsor');
  assert.equal(verifications.length, 4);
  assert.ok(verifications.every((t) => t.assigneeId === 'u_elena' || t.assigneeId === 'u_rafael'), 'only level-2+ users');
  assert.ok(verifications.some((t) => t.assigneeId === 'u_rafael'), 'work is shared with the second compliance user');
});

test('contact-change call-back never routes to a COMPLIANCE trainee, even when others are busy', async () => {
  const app = testApp();
  const trainee = addComplianceTrainee(app);
  const { plan } = await installPlan(app);
  for (const name of ['Omar', 'Lena', 'Kofi']) {
    await app.cases.submitIntake(
      { caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: plan.id, data: { contact: { role: 'PAYROLL', name, email: `${name.toLowerCase()}@acme.example` } } },
      'portal',
    );
  }
  const callbacks = app.repos.tasks.find((t) => t.stepId === 'verify-authority');
  assert.equal(callbacks.length, 3);
  assert.ok(callbacks.every((t) => (t.assigneeId === 'u_elena' || t.assigneeId === 'u_rafael') && t.minSkillLevel === 2));
  assert.throws(() => app.cases.reassign(callbacks[0].id, 'lead', trainee), /lacks COMPLIANCE L2/);
});

test('TRAC outage: install step goes to exception; retry is idempotent', async () => {
  const app = testApp();
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const all = () => Object.fromEntries(app.cases.tasksFor(kase.id).map((t) => [t.stepId, t]));
  for (const step of ['verify-sponsor', 'review-fund-lineup', 'fee-disclosure', 'welcome-email']) {
    const t = all()[step];
    await app.cases.completeTask(t.id, t.assigneeId!);
  }
  const install = all()['trac-install'];
  app.trac.failNext(10); // longer than the retry policy
  await assert.rejects(() => app.cases.completeTask(install.id, install.assigneeId!), /trac\.installPlan: 503 .*after 3 attempts/);
  assert.match(app.repos.tasks.require(install.id).exception!, /503/);
  app.trac.failNext(0);

  assert.equal((await app.cases.completeTask(install.id, install.assigneeId!)).status, 'DONE');
  await assert.rejects(() => app.cases.completeTask(install.id, install.assigneeId!), /is DONE/);
  assert.equal(app.trac.listPlans().length, 1);
  await workCase(app, kase.id); // remaining work, e.g. enrollment meetings for a 250-person plan
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
});

test('edited drafts are recorded and override requires justification', async () => {
  const app = testApp();
  const { tasks } = await app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: 'bad' }) } },
    'portal',
  );
  const v = tasks.find((t) => t.stepId === 'validate-intake')!;
  await assert.rejects(() => app.cases.completeTask(v.id, v.assigneeId!, { override: true }), /justification/);
  const ok = await app.cases.completeTask(v.id, v.assigneeId!, { override: true, notes: 'EIN confirmed by phone; form typo' });
  assert.equal(ok.status, 'DONE');
  assert.ok(app.repos.audit.all().some((e) => e.event === 'task.overridden'));
});

test('insights: suggests promoting a never-edited review step and fixing an often-edited template', async () => {
  const app = testApp();
  for (let i = 0; i < 5; i++) {
    const { case: kase } = await app.cases.submitIntake(
      { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: `12-345678${i}` }) } },
      'portal',
    );
    await workCase(app, kase.id, { edits: (step, d) => (step === 'welcome-email' ? { body: d!.body + '\nP.S. Your kickoff call is next week.' } : undefined) });
  }
  const ins = app.insights();
  assert.equal(ins.cases.completed, 5);
  assert.ok(ins.suggestions.some((s) => s.kind === 'promote-to-auto' && s.target === 'INSTALLATION / fee-disclosure'));
  assert.ok(ins.suggestions.some((s) => s.kind === 'fix-template' && s.target === 'INSTALLATION / welcome-email'));
});

test('playbook validation catches unknown dependencies and cycles', async () => {
  const step = (id: string, dependsOn: string[]) => ({ id, name: id, skill: 'X', mode: 'AUTO' as const, action: { type: 'none' as const }, guidance: '', dependsOn });
  assert.throws(() => validatePlaybook({ id: 'p', version: 1, caseType: 'INSTALLATION', name: '', description: '', steps: [step('a', ['zz'])] }), /unknown step/);
  assert.throws(() => validatePlaybook({ id: 'p', version: 1, caseType: 'INSTALLATION', name: '', description: '', steps: [step('a', ['b']), step('b', ['a'])] }), /cycle/);
});

test('onboarding data cannot be edited once the plan is live on TRAC', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  assert.throws(() => app.cases.updatePlanDetails(plan.id, { employeeCount: 1 }, 'u_priya'), /maintenance request/);
});

test('rewritten emails must keep the facts the template put in them', async () => {
  const app = testApp();
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const t = Object.fromEntries(app.cases.tasksFor(kase.id).map((x) => [x.stepId, x]));
  await app.cases.completeTask(t['review-fund-lineup'].id, 'u_sam');
  const fee = app.repos.tasks.require(app.cases.tasksFor(kase.id).find((x) => x.stepId === 'fee-disclosure')!.id);
  const g = app.guidance.forTask(app.cases.contextFor(fee, fee.assigneeId!));
  assert.ok(g.prepared?.kind === 'email');
  if (g.prepared?.kind !== 'email') return;
  assert.ok(g.prepared.requiredFacts.includes('Acme Robotics Inc.'));
  assert.ok(g.prepared.requiredFacts.includes('2500'));
  // Dropping the deconversion fee is blocked...
  const body = g.prepared.body.replace(/.*Deconversion fee.*\n/, '');
  await assert.rejects(() => app.cases.completeTask(fee.id, fee.assigneeId!, { edits: { body } }), (e: Error & { issues?: string[] }) => e.issues?.includes('2500') === true);
  // ...but rewording that keeps every fact (with thousands separators) is fine.
  const reworded = g.prepared.body.replace('$2500', '$2,500').replace('Dear Jane Doe', 'Hello Jane');
  assert.equal((await app.cases.completeTask(fee.id, fee.assigneeId!, { edits: { body: reworded } })).status, 'DONE');
});

test('policy: every COMPLIANCE step, in every process and client variant, requires level 2+', () => {
  const app = testApp();
  const offenders: string[] = [];
  for (const client of [{ clientId: 'default' }, ...app.kb.listClients()]) {
    for (const pb of app.kb.listPlaybooks()) {
      for (const s of app.kb.playbookFor(pb.caseType, client.clientId).steps) {
        if (s.skill === 'COMPLIANCE' && (s.minSkillLevel ?? 1) < 2) offenders.push(`${client.clientId}: ${pb.caseType} / ${s.id}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('termination authorization never routes to a COMPLIANCE trainee', async () => {
  const app = testApp();
  addComplianceTrainee(app);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { plan } = await installPlan(app, 'default', sampleDetails({ ein: `12-200000${i}` }));
    const { case: kase } = await app.cases.submitIntake(
      { caseType: 'TERMINATION', channel: 'DIGITAL', planId: plan.id, data: { reason: 'x', successorProvider: 'y', effectiveDate: '2027-02-15' } },
      'portal',
    );
    ids.push(app.cases.tasksFor(kase.id).find((t) => t.stepId === 'verify-authority')!.assigneeId!);
  }
  assert.ok(ids.every((u) => u === 'u_elena' || u === 'u_rafael'), ids.join(', '));
});

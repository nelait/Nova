import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPlan, sampleDetails, testApp, workCase } from './helpers.ts';

test('installation: auto steps run, human steps route by skill, plan lands on TRAC', () => {
  const app = testApp();
  const { case: kase, tasks } = app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } },
    'portal',
  );
  const byStep = Object.fromEntries(tasks.map((t) => [t.stepId, t]));
  assert.equal(byStep['validate-intake'].status, 'DONE');
  assert.equal(byStep['setup-contacts'].status, 'DONE');
  assert.equal(byStep['verify-sponsor'].assigneeId, 'u_elena'); // only COMPLIANCE L3
  assert.equal(byStep['review-fund-lineup'].assigneeId, 'u_sam'); // INVESTMENTS
  assert.equal(byStep['trac-install'].status, 'BLOCKED');

  // Inbox shows only that user's work.
  assert.deepEqual(app.cases.inbox('u_elena').map((t) => t.stepId), ['verify-sponsor']);

  // Guided action for the review step shows what will be applied.
  const g = app.guidance.forTask(app.cases.contextFor(byStep['review-fund-lineup'], 'u_sam'));
  assert.equal(g.prepared?.kind, 'system-update');
  assert.ok(g.regulatoryRef?.includes('QDIA'));

  workCase(app, kase.id);

  const done = app.repos.cases.require(kase.id);
  assert.equal(done.status, 'COMPLETED');
  const plan = app.repos.plans.require(kase.planId);
  assert.equal(plan.status, 'ACTIVE');
  assert.match(plan.tracPlanId!, /^TRAC-/);
  assert.equal(app.trac.getPlan(plan.tracPlanId!).sponsorName, 'Acme Robotics Inc.');

  const mails = app.email.list();
  assert.equal(mails.length, 2);
  const welcome = mails.find((m) => m.subject.startsWith('Welcome'))!;
  assert.deepEqual(welcome.to, ['jane.doe@acme.example']);
  assert.deepEqual(welcome.cc, ['payroll@acme.example']);
  assert.ok(!welcome.body.includes('[MISSING'));
});

test('ties go to the more proficient user; level-gated steps skip trainees', () => {
  const app = testApp();
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'MANUAL', data: { details: sampleDetails() } }, 'u_priya');
  workCase(app, kase.id);
  const t = Object.fromEntries(app.cases.tasksFor(kase.id).map((t) => [t.stepId, t]));
  assert.equal(t['welcome-email'].assigneeId, 'u_priya'); // L3 beats L1 at equal load
  assert.equal(t['trac-install'].assigneeId, 'u_priya'); // marcus is L1, step needs L2
  assert.equal(t['verify-sponsor'].assigneeId, 'u_elena'); // COMPLIANCE L3 over sam's L1
});

test('bad onboarding data becomes an exception for a person, who fixes and retries', () => {
  const app = testApp();
  const { case: kase, tasks } = app.cases.submitIntake(
    { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: '123', funds: [{ ticker: 'VFIAX', name: 'S&P 500' }] }) } },
    'portal',
  );
  const v = tasks.find((t) => t.stepId === 'validate-intake')!;
  assert.equal(v.status, 'READY');
  assert.match(v.exception!, /EIN/);
  assert.match(v.exception!, /QDIA/);
  assert.ok(v.assigneeId, 'exception routed to a PLAN_SETUP user');
  // Nothing downstream started.
  assert.ok(app.cases.tasksFor(kase.id).filter((t) => t.stepId !== 'validate-intake').every((t) => t.status === 'BLOCKED'));

  // Retry without fixing fails again.
  assert.throws(() => app.cases.completeTask(v.id, v.assigneeId!), /Validation failed/);

  app.cases.updatePlanDetails(kase.planId, { ein: '12-3456789', funds: sampleDetails().funds }, v.assigneeId!);
  const fixed = app.cases.completeTask(v.id, v.assigneeId!);
  assert.equal(fixed.status, 'DONE');
  assert.equal(app.cases.tasksFor(kase.id).find((t) => t.stepId === 'setup-contacts')!.status, 'DONE');
});

test('paper channel: OCR text is parsed into the same plan structure', () => {
  const app = testApp();
  const text = [
    'Sponsor Name: Bluebird Bakery LLC',
    'EIN: 98-7654321',
    'Employees: 1,200',
    'Plan Type: 401(k)',
    'Effective Date: 2027-02-01',
    'Plan Administrator: Ana Ruiz <ana@bluebird.example>',
    'Fund: FXAIX | Fidelity 500 Index',
    'Fund: FDEWX | Fidelity Freedom 2055 | QDIA',
  ].join('\n');
  const { case: kase, tasks } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'PAPER', documentText: text }, 'mailroom');
  const plan = app.repos.plans.require(kase.planId);
  assert.equal(plan.details.planType, '401K');
  assert.equal(plan.details.employeeCount, 1200);
  assert.equal(plan.details.funds.filter((f) => f.qdia).length, 1);
  assert.equal(tasks.find((t) => t.stepId === 'validate-intake')!.status, 'DONE');
});

test('maintenance: contact change reads from TRAC, updates TRAC, notifies old and new contact', () => {
  const app = testApp();
  const { plan } = installPlan(app);
  const { case: kase, tasks } = app.cases.submitIntake(
    {
      caseType: 'MAINTENANCE_CONTACT',
      channel: 'DIGITAL',
      planId: plan.id,
      data: { contact: { role: 'PLAN_ADMINISTRATOR', name: 'Omar Haddad', email: 'omar@acme.example' } },
    },
    'portal',
  );
  assert.equal(tasks.find((t) => t.stepId === 'verify-authority')!.assigneeId, 'u_elena');
  workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  const rk = app.trac.getPlan(plan.tracPlanId!);
  assert.equal(rk.contacts.find((c) => c.role === 'PLAN_ADMINISTRATOR')!.email, 'omar@acme.example');
  assert.equal(rk.version, 2);
  const confirm = app.email.list().find((m) => m.subject.startsWith('Plan contact updated'))!;
  assert.deepEqual(confirm.to, ['omar@acme.example']);
  assert.deepEqual(confirm.cc, ['jane.doe@acme.example']);
});

test('maintenance requests are rejected for plans not yet on the recordkeeper', () => {
  const app = testApp();
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  assert.throws(
    () => app.cases.submitIntake({ caseType: 'MAINTENANCE_FEES', channel: 'DIGITAL', planId: kase.planId, data: {} }, 'portal'),
    /requires an installed, active plan/,
  );
});

test('fund change too close to effective date fails validation (404(c) notice window)', () => {
  const app = testApp();
  const { plan } = installPlan(app);
  const { tasks } = app.cases.submitIntake(
    { caseType: 'MAINTENANCE_FUNDS', channel: 'DIGITAL', planId: plan.id, data: { effectiveDate: '2026-11-20', funds: sampleDetails().funds } },
    'portal',
  );
  assert.match(tasks.find((t) => t.stepId === 'validate-request')!.exception!, /less than 30 days/);
});

test('termination: fees calculated, notices sent, plan terminated on TRAC', () => {
  const app = testApp();
  const { plan } = installPlan(app);
  const { case: kase } = app.cases.submitIntake(
    {
      caseType: 'TERMINATION',
      channel: 'DIGITAL',
      planId: plan.id,
      data: { reason: 'Moving to new provider', successorProvider: 'Other Recordkeeper Co', effectiveDate: '2027-02-15', blackoutStart: '2027-02-10', blackoutEnd: '2027-03-05' },
    },
    'portal',
  );
  assert.equal(app.repos.plans.require(plan.id).status, 'TERMINATING');

  const calc = app.cases.tasksFor(kase.id).find((t) => t.stepId === 'calculate-fees')!;
  assert.equal(calc.assigneeId, 'u_dana');
  const g = app.guidance.forTask(app.cases.contextFor(calc, 'u_dana'));
  assert.equal(g.prepared?.kind, 'rules');
  if (g.prepared?.kind === 'rules') {
    // Q1 2027 start -> Feb 15 = 45 days. 12M * 8bps * 45/365 = 1183.56; 250 * $40 * 45/365 = 1232.88
    const o = g.prepared.result.outputs;
    assert.equal(g.prepared.result.ruleSet, 'termination-fees');
    assert.equal(o.prorationDays, 45);
    assert.equal(o.assetFeeUsd, 1183.56);
    assert.equal(o.participantFeeUsd, 1232.88);
    assert.equal(o.totalUsd, 4916.44);
  }

  workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  assert.equal(app.repos.plans.require(plan.id).status, 'TERMINATED');
  assert.equal(app.trac.getPlan(plan.tracPlanId!).status, 'TERMINATED');
  const confirm = app.email.list().find((m) => m.subject.startsWith('Confirmation of plan termination'))!;
  assert.match(confirm.body, /Total: \$4916\.44/);
});

test('cancelling a termination returns the plan to ACTIVE', () => {
  const app = testApp();
  const { plan } = installPlan(app);
  const { case: kase } = app.cases.submitIntake(
    { caseType: 'TERMINATION', channel: 'MANUAL', planId: plan.id, data: { reason: 'x', successorProvider: 'y', effectiveDate: '2027-03-01' } },
    'u_dana',
  );
  app.cases.cancelCase(kase.id, 'u_dana', 'Sponsor changed their mind');
  assert.equal(app.repos.plans.require(plan.id).status, 'ACTIVE');
});

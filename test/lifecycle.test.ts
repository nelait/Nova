import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPlan, sampleDetails, testApp, workCase } from './helpers.ts';

test('installation: auto steps run, human steps route by skill, plan lands on TRAC', async () => {
  const app = testApp();
  const { case: kase, tasks } = await app.cases.submitIntake(
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

  await workCase(app, kase.id);

  const done = app.repos.cases.require(kase.id);
  assert.equal(done.status, 'COMPLETED');
  const plan = app.repos.plans.require(kase.planId);
  assert.equal(plan.status, 'ACTIVE');
  assert.match(plan.tracPlanId!, /^TRAC-/);
  assert.equal(app.trac.getPlan(plan.tracPlanId!).sponsor.name, 'Acme Robotics Inc.');

  const mails = app.email.list();
  assert.equal(mails.length, 2);
  const welcome = mails.find((m) => m.subject.startsWith('Welcome'))!;
  assert.deepEqual(welcome.to, ['jane.doe@acme.example']);
  assert.deepEqual(welcome.cc, ['payroll@acme.example']);
  assert.ok(!welcome.body.includes('[MISSING'));
});

test('ties rotate evenly between eligible users regardless of seniority; level-gated steps skip trainees', async () => {
  const app = testApp();
  const steps: Record<string, string>[] = [];
  // Four installations worked to completion one after another, so everyone is
  // idle (equal load) whenever a task is routed: only the tie-break decides.
  for (let i = 0; i < 4; i++) {
    const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'MANUAL', data: { details: sampleDetails({ ein: `12-100000${i}` }) } }, 'u_priya');
    await workCase(app, kase.id);
    steps.push(Object.fromEntries(app.cases.tasksFor(kase.id).map((t) => [t.stepId, t.assigneeId ?? ''])));
  }
  // COMPLIANCE L2+ work (verification, fee disclosure) is split evenly between
  // Elena (L3) and Rafael (L2); Sam (L1) never gets it.
  const compliance = steps.flatMap((s) => [s['verify-sponsor'], s['fee-disclosure']]);
  assert.equal(compliance.filter((u) => u === 'u_elena').length, 4);
  assert.equal(compliance.filter((u) => u === 'u_rafael').length, 4);
  assert.ok(!compliance.includes('u_sam'));
  // PLAN_SETUP work with no minimum level rotates between Priya (L3) and Marcus (L1).
  const planSetup = steps.flatMap((s) => [s['welcome-email'], s['enrollment-meetings']]);
  assert.equal(planSetup.filter((u) => u === 'u_priya').length, planSetup.filter((u) => u === 'u_marcus').length);
  // The TRAC install needs PLAN_SETUP L2: always Priya, never Marcus (L1).
  assert.ok(steps.every((s) => s['trac-install'] === 'u_priya'));
});

test('bad onboarding data becomes an exception for a person, who fixes and retries', async () => {
  const app = testApp();
  const { case: kase, tasks } = await app.cases.submitIntake(
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
  await assert.rejects(() => app.cases.completeTask(v.id, v.assigneeId!), /Validation failed/);

  app.cases.updatePlanDetails(kase.planId, { ein: '12-3456789', funds: sampleDetails().funds }, v.assigneeId!);
  const fixed = await app.cases.completeTask(v.id, v.assigneeId!);
  assert.equal(fixed.status, 'DONE');
  assert.equal(app.cases.tasksFor(kase.id).find((t) => t.stepId === 'setup-contacts')!.status, 'DONE');
});

test('paper channel: OCR text is parsed into the same plan structure', async () => {
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
  const { case: kase, tasks } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'PAPER', documentText: text }, 'mailroom');
  const plan = app.repos.plans.require(kase.planId);
  assert.equal(plan.details.planType, '401K');
  assert.equal(plan.details.employeeCount, 1200);
  assert.equal(plan.details.funds.filter((f) => f.qdia).length, 1);
  assert.equal(tasks.find((t) => t.stepId === 'validate-intake')!.status, 'DONE');
});

test('maintenance: contact change reads from TRAC, updates TRAC, notifies old and new contact', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  const { case: kase, tasks } = await app.cases.submitIntake(
    {
      caseType: 'MAINTENANCE_CONTACT',
      channel: 'DIGITAL',
      planId: plan.id,
      data: { contact: { role: 'PLAN_ADMINISTRATOR', name: 'Omar Haddad', email: 'omar@acme.example' } },
    },
    'portal',
  );
  assert.equal(tasks.find((t) => t.stepId === 'verify-authority')!.assigneeId, 'u_elena');
  await workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  const rk = app.trac.getPlan(plan.tracPlanId!);
  assert.equal(rk.contacts.find((c) => c.role === 'PLAN_ADMINISTRATOR')!.email, 'omar@acme.example');
  assert.equal(rk.version, 2);
  const confirm = app.email.list().find((m) => m.subject.startsWith('Plan contact updated'))!;
  assert.deepEqual(confirm.to, ['omar@acme.example']);
  assert.deepEqual(confirm.cc, ['jane.doe@acme.example']);
});

test('maintenance requests are rejected for plans not yet on the recordkeeper', async () => {
  const app = testApp();
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  await assert.rejects(
    () => app.cases.submitIntake({ caseType: 'MAINTENANCE_FEES', channel: 'DIGITAL', planId: kase.planId, data: {} }, 'portal'),
    /requires an installed, active plan/,
  );
});

test('fund change too close to effective date fails validation (404(c) notice window)', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  const { tasks } = await app.cases.submitIntake(
    { caseType: 'MAINTENANCE_FUNDS', channel: 'DIGITAL', planId: plan.id, data: { effectiveDate: '2026-11-20', funds: sampleDetails().funds } },
    'portal',
  );
  assert.match(tasks.find((t) => t.stepId === 'validate-request')!.exception!, /less than 30 days/);
});

test('termination: fees calculated, notices sent, plan terminated on TRAC', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  const { case: kase } = await app.cases.submitIntake(
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

  await workCase(app, kase.id);
  assert.equal(app.repos.cases.require(kase.id).status, 'COMPLETED');
  assert.equal(app.repos.plans.require(plan.id).status, 'TERMINATED');
  assert.equal(app.trac.getPlan(plan.tracPlanId!).status, 'TERMINATED');
  const confirm = app.email.list().find((m) => m.subject.startsWith('Confirmation of plan termination'))!;
  assert.match(confirm.body, /Total: \$4916\.44/);
});

test('cancelling a termination returns the plan to ACTIVE', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  const { case: kase } = await app.cases.submitIntake(
    { caseType: 'TERMINATION', channel: 'MANUAL', planId: plan.id, data: { reason: 'x', successorProvider: 'y', effectiveDate: '2027-03-01' } },
    'u_dana',
  );
  app.cases.cancelCase(kase.id, 'u_dana', 'Sponsor changed their mind');
  assert.equal(app.repos.plans.require(plan.id).status, 'ACTIVE');
});

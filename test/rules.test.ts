import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compile, compileTemplate, RuleError } from '../src/rules/expression.ts';
import { compileRuleSet, evaluateRuleSet, RuleRegistry, CONTEXT_ROOTS } from '../src/rules/ruleEngine.ts';
import { validatePlaybook } from '../src/knowledge/knowledgeBase.ts';
import { installPlan, sampleDetails, testApp, workCase } from './helpers.ts';

const ROOTS = ['plan', 'request', 'outputs', 'today'];
const ev = (src: string, ctx: Record<string, unknown> = {}) => compile(src, ROOTS).eval(ctx);

// ------------------------------------------------------------ expression language

test('expressions: arithmetic, precedence, comparison, logic', async () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('10 % 4 - -1'), 3);
  assert.equal(ev('2 > 1 and not (1 > 2) or false'), true);
  assert.equal(ev('1 < 2 ? "yes" : "no"'), 'yes');
  assert.equal(ev("'2026-11-05' < '2027-01-01'"), true, 'ISO dates compare as text');
  assert.equal(ev("'B' in ['A', 'B']"), true);
  assert.equal(ev("'a' + 1"), 'a1');
  assert.equal(ev('1_000_000 / 4'), 250000);
});

test('expressions: reading data and safe navigation', async () => {
  const ctx = { plan: { details: { funds: [{ ticker: 'A', qdia: true }, { ticker: 'B' }], name: 'X' } } };
  assert.equal(ev("countWhere(plan.details.funds, 'qdia', true)", ctx), 1);
  assert.equal(ev("plan.details['name']", ctx), 'X');
  assert.equal(ev('plan.details.funds[1].ticker', ctx), 'B');
  assert.equal(ev('plan.missing.deeper.still', ctx), undefined, 'missing data reads as missing');
  assert.equal(ev('isBlank(request.contact)', ctx), true);
  assert.equal(ev('plan.details.missing > 0', ctx), false, 'comparing missing values is false, not an error');
});

test('expressions: functions', async () => {
  assert.equal(ev("daysBetween('2026-11-05', '2027-01-01')"), 57);
  assert.equal(ev("quarterStart('2027-02-15')"), '2027-01-01');
  assert.equal(ev("addDays('2026-12-30', 3)"), '2027-01-02');
  assert.equal(ev("isDate('2027-02-30')"), false);
  assert.equal(ev('round(1183.5616, 2)'), 1183.56);
  assert.equal(ev('usd(4916.4)'), '$4,916.40');
  assert.equal(ev("matches('12-3456789', '^[0-9]{2}-[0-9]{7}$')"), true);
  assert.equal(ev("emailDomain('Jane@Acme.Example')"), 'acme.example');
  assert.equal(ev('hasDuplicates([1, 2, 2])'), true);
  assert.equal(ev('coalesce(null, plan.x, 5)', { plan: {} }), 5);
});

test('expressions: unsafe or invalid input is rejected', async () => {
  assert.throws(() => compile('process.exit()', ROOTS), RuleError, 'no method calls');
  assert.throws(() => compile('process', ROOTS), /Unknown name "process"/);
  assert.throws(() => compile('globalThis', ROOTS), /Unknown name "globalThis"/);
  assert.throws(() => compile('plan.constructor', ROOTS), /not allowed/);
  assert.throws(() => compile('plan.__proto__', ROOTS), /not allowed/);
  assert.throws(() => ev("plan['__proto__']", { plan: {} }), /not allowed/);
  assert.throws(() => compile('eval("1")', ROOTS), /Unknown function "eval"/);
  assert.throws(() => compile('round()', ROOTS), /takes 1-2 argument/);
  assert.throws(() => compile('1 +', ROOTS), RuleError);
  assert.throws(() => compile('a = 1', ROOTS), RuleError);
  assert.throws(() => ev('1 / 0'), /Division by zero/);
  assert.throws(() => ev('plan.x * 2', { plan: {} }), /expected a number/);
  assert.throws(() => compile('('.repeat(100) + '1' + ')'.repeat(100), ROOTS), /nested too deeply/);
});

test('message templates interpolate expressions', async () => {
  const t = compileTemplate('Found {{ outputs.n }} QDIAs; total {{ usd(outputs.t) }}', ROOTS);
  assert.equal(t({ outputs: { n: 2, t: 1234.5 } }), 'Found 2 QDIAs; total $1,234.50');
});

// ------------------------------------------------------------ rule engine

test('rule engine: decisions, chained outputs, conditional rules, severities, trace', async () => {
  const set = compileRuleSet({
    id: 't',
    version: 3,
    name: 'Test',
    decisions: [{ id: 'size', rows: [{ when: 'plan.n < 10', then: { name: 'small' } }, { then: { name: 'big' } }] }],
    outputs: [
      { name: 'double', expr: 'plan.n * 2' },
      { name: 'quad', expr: 'outputs.double * 2' },
    ],
    rules: [
      { id: 'positive', assert: 'plan.n > 0', message: 'n must be positive' },
      { id: 'small-only', when: "decisions.size.name == 'small'", assert: 'plan.n < 5', severity: 'warning', message: 'n is {{plan.n}}' },
      { id: 'broken', assert: 'plan.n * plan.missing > 0', message: 'never shown' },
    ],
  });
  const r = evaluateRuleSet(set, { plan: { n: 7 } });
  assert.deepEqual(r.decisions.size, { name: 'small', row: 1 });
  assert.equal(r.outputs.quad, 28);
  assert.equal(r.passed, false, 'a rule that cannot be evaluated counts as an error');
  assert.deepEqual(r.issues.map((i) => [i.ruleId, i.severity]), [['small-only', 'warning'], ['broken', 'error']]);
  assert.equal(r.issues[0].message, 'n is 7');
  assert.deepEqual(r.trace.filter((x) => x.kind === 'rule').map((x) => x.outcome), ['pass', 'fail', 'error']);
  assert.equal(evaluateRuleSet(set, { plan: { n: 20 } }).decisions.size.name, 'big');
});

test('rule sets are checked when they load', async () => {
  assert.throws(() => compileRuleSet({ id: 'x', version: 1, name: 'x', rules: [{ id: 'a', assert: 'plan.n >', message: 'm' }] }), /rule "a" assert/);
  assert.throws(() => compileRuleSet({ id: 'x', version: 1, name: 'x', rules: [{ id: 'a', assert: 'nope.n > 1', message: 'm' }] }), /Unknown name "nope"/);
  assert.throws(() => compileRuleSet({ id: 'x', version: 1, name: 'x', outputs: [{ name: 'a', expr: '1' }, { name: 'a', expr: '2' }] }), /duplicate output/);
  assert.throws(() => compileRuleSet({ id: 'x', version: 1, name: 'x', rules: [{ id: 'a', assert: 'true', message: '{{ bad( }}' }] }), /message/);
  assert.ok(CONTEXT_ROOTS.includes('steps'));
});

test('every rule set in config passes its own test cases', async () => {
  const reg = new RuleRegistry(join(import.meta.dirname, '..', 'config', 'rules'));
  assert.ok(reg.list().length >= 7);
  for (const s of reg.list()) {
    assert.ok((s.tests ?? []).length > 0, `${s.id} has no tests`);
    for (const t of reg.test(s.id)) assert.ok(t.passed, `${s.id} / ${t.name}: ${t.failures.join('; ')}`);
  }
});

test('playbooks are rejected if they use an unknown rule set or a bad step condition', async () => {
  const reg = new RuleRegistry(join(import.meta.dirname, '..', 'config', 'rules'));
  const pb = (step: object) => ({ id: 'p', version: 1, caseType: 'INSTALLATION' as const, name: '', description: '', steps: [{ id: 's', name: 's', skill: 'X', mode: 'AUTO' as const, guidance: '', ...step }] });
  assert.throws(() => validatePlaybook(pb({ action: { type: 'rules.evaluate', params: { ruleSet: 'nope' } } }) as never, reg), /unknown rule set "nope"/);
  assert.throws(() => validatePlaybook(pb({ action: { type: 'none' }, when: 'outputs.x > 1' }) as never, reg), /condition: Unknown name "outputs"/);
  assert.doesNotThrow(() => validatePlaybook(pb({ action: { type: 'none' }, when: "steps['a'].x > 1" }) as never, reg));
});

// ------------------------------------------------------------ rules as process steps

test('rule step result feeds a step condition: small plans skip enrollment meetings', async () => {
  const app = testApp();
  const small = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ employeeCount: 40 }) } }, 'portal');
  const mid = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ employeeCount: 400, ein: '12-0000001' }) } }, 'portal');
  await workCase(app, small.case.id);
  await workCase(app, mid.case.id);
  const step = (caseId: string) => app.cases.tasksFor(caseId).find((t) => t.stepId === 'enrollment-meetings')!;
  assert.equal(step(small.case.id).status, 'SKIPPED');
  assert.ok(step(small.case.id).history.some((h) => h.event === 'skipped'));
  assert.equal(step(mid.case.id).status, 'DONE');
  assert.equal(app.repos.cases.require(small.case.id).status, 'COMPLETED');

  const v = app.cases.tasksFor(small.case.id).find((t) => t.stepId === 'validate-intake')!;
  const result = v.result as { ruleSet: string; version: number; decisions: { segment: { name: string } } };
  assert.equal(result.ruleSet, 'installation-intake');
  assert.equal(result.decisions.segment.name, 'small');
});

test('warnings do not block a rule step; errors become an exception for a person', async () => {
  const app = testApp();
  // 30 days out: passes validation with a lead-time warning.
  const { tasks } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ effectiveDate: '2026-12-05' }) } }, 'portal');
  const v = tasks.find((t) => t.stepId === 'validate-intake')!;
  assert.equal(v.status, 'DONE');
  const issues = (v.result as { issues: { ruleId: string; severity: string }[] }).issues;
  assert.deepEqual(issues.map((i) => [i.ruleId, i.severity]), [['effective-date-lead-time', 'warning']]);

  const bad = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: '12-0000002', fees: { recordkeepingBps: 40, perParticipantUsd: 40, terminationBaseUsd: 2500 }, effectiveDate: '2026-10-01' }) } }, 'portal');
  const e = bad.tasks.find((t) => t.stepId === 'validate-intake')!;
  assert.match(e.exception!, /in the past/);
  assert.doesNotMatch(e.exception!, /unusually high/, 'warnings are not listed as blocking issues');
});

test('client rule set override: premium clients have the deconversion fee waived', async () => {
  const app = testApp();
  const { plan } = await installPlan(app, 'acme-premium');
  const { case: kase } = await app.cases.submitIntake(
    { caseType: 'TERMINATION', channel: 'DIGITAL', planId: plan.id, data: { reason: 'x', successorProvider: 'y', effectiveDate: '2027-02-15', blackoutStart: '2027-02-10', blackoutEnd: '2027-03-05' } },
    'portal',
  );
  const calc = app.cases.tasksFor(kase.id).find((t) => t.stepId === 'calculate-fees')!;
  const g = app.guidance.forTask(app.cases.contextFor(calc, calc.assigneeId!));
  assert.ok(g.prepared?.kind === 'rules');
  if (g.prepared?.kind !== 'rules') return;
  assert.equal(g.prepared.result.ruleSet, 'termination-fees-premium');
  assert.equal(g.prepared.result.outputs.baseFeeUsd, 0);
  await workCase(app, kase.id);
  assert.match(app.email.list().find((m) => m.subject.startsWith('Confirmation of plan termination'))!.body, /Deconversion fee: \$0\n/);
});

test('contact change to a free-mail address passes validation with a fraud warning', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  const { tasks } = await app.cases.submitIntake(
    { caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: plan.id, data: { contact: { role: 'PLAN_ADMINISTRATOR', name: 'J', email: 'j@freemail.example' } } },
    'portal',
  );
  const v = tasks.find((t) => t.stepId === 'validate-request')!;
  assert.equal(v.status, 'DONE');
  assert.match(JSON.stringify(v.result), /possible fraud attempt/);
});

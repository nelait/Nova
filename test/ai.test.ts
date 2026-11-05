import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { sampleDetails, testApp } from './helpers.ts';
import { AiError, claudeModelCall, type AssistOutput, type ModelCall } from '../src/ai/claudeAssist.ts';
import type { App } from '../src/app.ts';

/** Fake model: records prompts, returns whatever `respond` builds. */
function fakeModel(respond: (user: string) => AssistOutput) {
  const calls: string[] = [];
  const call: ModelCall = async ({ user }) => {
    calls.push(user);
    return { output: respond(user), model: 'claude-opus-5-5', servedBy: 'claude-opus-5-5', usage: { inputTokens: 1000, outputTokens: 200 } };
  };
  return { call, calls };
}

/** Pulls the templated email out of the prompt and rewrites its greeting, keeping every fact. */
function rewriteFromPrompt(user: string): AssistOutput {
  const prepared = JSON.parse(user.split('<prepared_work>\n')[1].split('\n</prepared_work>')[0]);
  return {
    briefing: 'Fee disclosure for a new 250-participant plan.',
    risks: [{ severity: 'Low', message: 'Plan assets are large relative to headcount; confirm the asset figure.' }],
    checks: ['Confirm the bps rate matches the signed agreement'],
    emailDraft:
      prepared.kind === 'email'
        ? { subject: prepared.subject, body: prepared.body.replace(/^Dear [^,]+,/, 'Hello,'), changes: 'Warmer greeting.' }
        : { subject: 'should be dropped', body: 'not an email step', changes: '' },
  };
}

function openStep(app: App, caseId: string, stepId: string) {
  return app.cases.tasksFor(caseId).find((t) => t.stepId === stepId)!;
}

function readyFeeDisclosure(app: App) {
  const { case: kase } = app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  app.cases.completeTask(openStep(app, kase.id, 'review-fund-lineup').id, 'u_sam');
  return { kase, task: openStep(app, kase.id, 'fee-disclosure') };
}

test('AI assist is off without a model and says why', async () => {
  const app = testApp();
  assert.equal(app.ai.enabled, false);
  const { task } = readyFeeDisclosure(app);
  await assert.rejects(app.ai.assist(task.id, task.assigneeId!), AiError);
});

test('prompt carries guidance, case data and required facts in separate data blocks', async () => {
  const fake = fakeModel(rewriteFromPrompt);
  const app = testApp(fake.call);
  const { task } = readyFeeDisclosure(app);
  await app.ai.assist(task.id, task.assigneeId!);
  const user = fake.calls[0];
  assert.match(user, /<task>[\s\S]*408\(b\)\(2\)[\s\S]*<\/task>/);
  assert.match(user, /<case_data>[\s\S]*12-3456789[\s\S]*<\/case_data>/);
  assert.match(user, /"required_facts": \[[\s\S]*"2500"/);
});

test('AI email draft keeps facts, is cached, and refreshes when the case changes', async () => {
  const fake = fakeModel(rewriteFromPrompt);
  const app = testApp(fake.call);
  const { kase, task } = readyFeeDisclosure(app);

  const a1 = await app.ai.assist(task.id, task.assigneeId!);
  assert.ok(a1.emailDraft);
  assert.deepEqual(a1.emailDraft!.missingFacts, []);
  assert.deepEqual(a1.risks.map((r) => r.severity), ['low'], 'severity normalized');

  const a2 = await app.ai.assist(task.id, task.assigneeId!);
  assert.equal(a2.cached, true);
  assert.equal(fake.calls.length, 1, 'second request served from cache');

  await app.ai.assist(task.id, task.assigneeId!, true);
  assert.equal(fake.calls.length, 2, 'refresh forces a new call');

  app.cases.updatePlanDetails(kase.planId, { planAssetsUsd: 9_000_000 }, 'u_priya');
  await app.ai.assist(task.id, task.assigneeId!);
  assert.equal(fake.calls.length, 3, 'changed case data invalidates the cache');

  assert.ok(app.repos.audit.all().some((e) => e.event === 'task.ai-assisted'));
});

test('AI draft that drops a required fact is flagged and cannot be sent', async () => {
  const fake = fakeModel((user) => {
    const out = rewriteFromPrompt(user);
    out.emailDraft!.body = out.emailDraft!.body.replace(/.*Deconversion fee.*\n/, '');
    return out;
  });
  const app = testApp(fake.call);
  const { task } = readyFeeDisclosure(app);
  const a = await app.ai.assist(task.id, task.assigneeId!);
  assert.deepEqual(a.emailDraft!.missingFacts, ['2500']);
  assert.throws(
    () => app.cases.completeTask(task.id, task.assigneeId!, { edits: { subject: a.emailDraft!.subject, body: a.emailDraft!.body }, draftSource: 'ai' }),
    /missing required facts/,
  );
});

test('non-email steps never get an email draft, even if the model returns one', async () => {
  const fake = fakeModel(rewriteFromPrompt);
  const app = testApp(fake.call);
  const { kase } = readyFeeDisclosure(app);
  const verify = openStep(app, kase.id, 'verify-sponsor');
  const a = await app.ai.assist(verify.id, verify.assigneeId!);
  assert.equal(a.emailDraft, null);
});

test('sending Claude\'s draft records the source and edits are measured against it', async () => {
  const fake = fakeModel(rewriteFromPrompt);
  const app = testApp(fake.call);
  const { task } = readyFeeDisclosure(app);
  const a = await app.ai.assist(task.id, task.assigneeId!);
  const done = app.cases.completeTask(task.id, task.assigneeId!, {
    edits: { subject: a.emailDraft!.subject, body: a.emailDraft!.body },
    draftSource: 'ai',
  });
  assert.equal(done.draftSource, 'ai');
  assert.equal(done.draftEdited, false);
  assert.match(app.email.list()[0].body, /^Hello,/);
  const step = app.insights().steps.find((s) => s.stepId === 'fee-disclosure')!;
  assert.equal(step.aiDraftsUsed, 1);
  assert.equal(step.aiDraftEditRate, 0);
});

test('claudeModelCall sends structured-output request with fallbacks and handles refusals', async () => {
  let captured: Record<string, unknown> | undefined;
  const output: AssistOutput = { briefing: 'b', risks: [], checks: [], emailDraft: null };
  let reply: Record<string, unknown> = { stop_reason: 'end_turn', parsed_output: output, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } };
  const stub = { beta: { messages: { parse: async (params: Record<string, unknown>) => ((captured = params), reply) } } } as unknown as Anthropic;

  const call = claudeModelCall(stub);
  const r = await call({ system: 'sys', user: 'u' });
  assert.equal(r.output.briefing, 'b');
  assert.equal(captured!.model, 'claude-opus-5-5');
  assert.equal(captured!.fallbacks, 'default');
  assert.deepEqual(captured!.betas, ['server-side-fallback-2026-07-01']);
  const oc = captured!.output_config as { effort: string; format: { type: string } };
  assert.equal(oc.effort, 'medium');
  assert.equal(oc.format.type, 'json_schema');
  assert.equal('thinking' in captured!, false);

  reply = { stop_reason: 'refusal', stop_details: { category: 'cyber' }, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 0 } };
  await assert.rejects(call({ system: 's', user: 'u' }), /declined.*cyber/);
  reply = { stop_reason: 'end_turn', parsed_output: null, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 0 } };
  await assert.rejects(call({ system: 's', user: 'u' }), /did not match/);
});

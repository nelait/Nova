import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { installPlan, testApp } from './helpers.ts';
import { AgentRegistry, claudeAgentModel, type AgentModel, type AgentDef } from '../src/ai/agents.ts';
import { checkSchema, validate } from '../src/ai/jsonSchema.ts';
import { validatePlaybook } from '../src/knowledge/knowledgeBase.ts';
import type { App } from '../src/app.ts';
import type { Fund } from '../src/domain/types.ts';

const NEW_LINEUP: Fund[] = [
  { ticker: 'FXAIX', name: 'Fidelity 500 Index' },
  { ticker: 'VBTLX', name: 'Vanguard Total Bond Market Index Admiral' },
  { ticker: 'VTTSX', name: 'Vanguard Target Retirement 2060', qdia: true },
];

/** A scripted agent: looks the funds up with its tool, then maps by name. Records what it was given. */
function scriptedAgent(opts: { mapTo?: (from: string) => string; fail?: () => boolean } = {}) {
  const prompts: string[] = [];
  const model: AgentModel = async ({ user, tools }) => {
    prompts.push(user);
    if (opts.fail?.()) throw new Error('model unavailable');
    const data = JSON.parse(user.split('<case_data>\n')[1].split('\n</case_data>')[0]) as { removedFunds: Fund[]; newLineup: Fund[] };
    const tickers = [...data.removedFunds, ...data.newLineup].map((f) => f.ticker);
    const looked = (await tools[0].run({ tickers })) as { funds: { ticker: string; name: string }[] };
    const name = (t: string) => looked.funds.find((f) => f.ticker === t)?.name ?? t;
    const mappings = data.removedFunds.map((f) => {
      const to = opts.mapTo?.(f.ticker) ?? data.newLineup.find((n) => /500/.test(name(n.ticker)) && /500/.test(name(f.ticker)))?.ticker ?? data.newLineup.find((n) => n.qdia)!.ticker;
      return { fromTicker: f.ticker, toTicker: to, rationale: `${name(f.ticker)} and ${name(to)} track the same index.` };
    });
    return {
      output: { mappings, unmatchedFunds: [], confidence: 'high', reviewerNotes: 'Share classes differ; check expense ratios.' },
      model: 'test-model',
      servedBy: 'test-model',
      usage: { inputTokens: 100, outputTokens: 50 },
      toolCalls: [{ tool: tools[0].name, input: { tickers }, ok: true }],
    };
  };
  return { model, prompts };
}

async function fundChange(app: App) {
  const { plan } = await installPlan(app);
  const { case: kase } = await app.cases.submitIntake(
    { caseType: 'MAINTENANCE_FUNDS', channel: 'DIGITAL', planId: plan.id, data: { effectiveDate: '2026-12-20', funds: NEW_LINEUP } },
    'portal',
  );
  const step = (id: string) => app.cases.tasksFor(kase.id).find((t) => t.stepId === id)!;
  return { plan, kase, step };
}

test('agent step: proposal made with a read-only tool, approved by a person, then checked by rules and used in the notice', async () => {
  const agent = scriptedAgent();
  const app = testApp(null, agent.model);
  const { kase, step } = await fundChange(app);

  const t = step('propose-fund-mapping');
  assert.equal(t.status, 'READY', 'waits for a person');
  assert.equal(t.assigneeId, 'u_sam');
  assert.deepEqual(t.proposal!.output, {
    mappings: [{ fromTicker: 'VFIAX', toTicker: 'FXAIX', rationale: 'Vanguard 500 Index Admiral and Fidelity 500 Index track the same index.' }],
    unmatchedFunds: [],
    confidence: 'high',
    reviewerNotes: 'Share classes differ; check expense ratios.',
  });
  assert.deepEqual(t.proposal!.schemaIssues, []);
  // The tool went through the integration layer, attributed to the agent.
  assert.ok(app.integrations.calls().some((c) => c.system === 'fund-catalog' && c.actor === 'agent:fund-mapping' && c.taskId === t.id));
  // Nothing downstream ran before approval.
  assert.equal(step('check-fund-mapping').status, 'BLOCKED');

  const g = app.guidance.forTask(app.cases.contextFor(t, 'u_sam'));
  assert.equal(g.prepared?.kind, 'agent');

  const done = await app.cases.completeTask(t.id, 'u_sam');
  assert.equal(done.status, 'DONE');
  assert.equal(done.draftSource, 'ai');
  assert.equal(done.draftEdited, false);
  assert.equal(step('check-fund-mapping').status, 'DONE');

  const notice = step('participant-notice');
  await app.cases.completeTask(notice.id, notice.assigneeId!);
  const mail = app.email.list().find((m) => m.subject.startsWith('Upcoming change to investment options'))!;
  assert.match(mail.body, /Balances in removed funds will move as follows:\n {2}- VFIAX -> FXAIX/);

  const step2 = app.insights().steps.find((s) => s.stepId === 'propose-fund-mapping')!;
  assert.equal(step2.aiDraftsUsed, 1);
  assert.ok(app.repos.audit.all().some((e) => e.event === 'task.agent-proposed' && e.caseId === kase.id));
});

test('the agent sees only its configured input, not the whole case', async () => {
  const agent = scriptedAgent();
  const app = testApp(null, agent.model);
  await fundChange(app);
  const prompt = agent.prompts[0];
  assert.match(prompt, /"removedFunds"/);
  assert.match(prompt, /VFIAX/);
  assert.doesNotMatch(prompt, /12-3456789/, 'sponsor EIN is not sent');
  assert.doesNotMatch(prompt, /jane\.doe@acme\.example/, 'contact emails are not sent');
});

test('reviewer edits are validated against the schema and recorded as edits', async () => {
  const app = testApp(null, scriptedAgent().model);
  const { step } = await fundChange(app);
  const t = step('propose-fund-mapping');
  await assert.rejects(
    () => app.cases.completeTask(t.id, 'u_sam', { edits: { output: { mappings: 'none' } } }),
    (e: Error & { issues?: string[] }) => /does not match/.test(e.message) && !!e.issues?.some((i) => i.includes('$.mappings: expected array')),
  );
  const edited = { ...t.proposal!.output as object, confidence: 'medium', reviewerNotes: 'Checked expense ratios: fine.' };
  const done = await app.cases.completeTask(t.id, 'u_sam', { edits: { output: edited } });
  assert.equal(done.draftEdited, true);
  assert.equal((done.result as { edited: boolean; source: string }).source, 'agent');
});

test('rules catch an approved mapping that is wrong', async () => {
  const app = testApp(null, scriptedAgent({ mapTo: () => 'VFIAX' }).model); // maps to the fund being removed
  const { step } = await fundChange(app);
  await app.cases.completeTask(step('propose-fund-mapping').id, 'u_sam');
  assert.match(step('check-fund-mapping').exception!, /not in the new lineup: VFIAX/);
  assert.equal(step('participant-notice').status, 'BLOCKED');
});

test('agent failure becomes an exception; Retry runs the agent again', async () => {
  let down = true;
  const app = testApp(null, scriptedAgent({ fail: () => down }).model);
  const { step } = await fundChange(app);
  const t = step('propose-fund-mapping');
  assert.match(t.exception!, /AI agent could not produce a proposal: model unavailable/);
  assert.equal(t.proposal, undefined);
  down = false;
  const retried = await app.cases.completeTask(t.id, 'u_sam'); // "Retry"
  assert.equal(retried.status, 'IN_PROGRESS', 'still open, waiting for approval');
  assert.equal(retried.exception, undefined);
  assert.ok(retried.proposal);
});

test('without AI the step still works: the person enters the result by hand', async () => {
  const app = testApp(); // no agent model
  const { step } = await fundChange(app);
  const t = step('propose-fund-mapping');
  assert.match(t.exception!, /AI is not configured/);
  const g = app.guidance.forTask(app.cases.contextFor(t, 'u_sam'));
  assert.ok(g.allowedActions.includes('approve'));
  if (g.prepared?.kind !== 'agent') throw new Error('expected agent');
  assert.deepEqual(g.prepared.editable, { mappings: [], unmatchedFunds: [], confidence: 'high', reviewerNotes: '' });
  const output = { mappings: [{ fromTicker: 'VFIAX', toTicker: 'FXAIX', rationale: 'Same index' }], unmatchedFunds: [], confidence: 'high', reviewerNotes: '' };
  const done = await app.cases.completeTask(t.id, 'u_sam', { edits: { output } });
  assert.equal(done.status, 'DONE');
  assert.equal((done.result as { source: string }).source, 'manual');
  assert.equal(step('check-fund-mapping').status, 'DONE');
});

// ------------------------------------------------------------ configuration checks

test('agents may only use read-only tools; their steps must be human-reviewed', () => {
  const app = testApp();
  const base = app.kb.agents.get('fund-mapping');
  const reg = new AgentRegistry(undefined, app.kb.integrations);
  const tool = (system: string, operation: string) => ({ ...base, id: 'x', tools: [{ ...base.tools![0], system, operation }] });
  assert.throws(() => reg.add(tool('trac', 'updatePlan'), app.kb.integrations), /not read-only/);
  assert.doesNotThrow(() => reg.add(tool('trac', 'getPlan'), app.kb.integrations), 'GET is read-only');
  assert.throws(() => reg.add({ ...base, id: 'y', input: { x: '=nope.y' } } as AgentDef, app.kb.integrations), /Unknown name "nope"/);
  assert.throws(() => reg.add({ ...base, id: 'z', output: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }, app.kb.integrations), /additionalProperties: false/);

  const pb = (mode: 'AUTO' | 'REVIEW', agent = 'fund-mapping') => ({ id: 'p', version: 1, caseType: 'INSTALLATION' as const, name: '', description: '', steps: [{ id: 's', name: 's', skill: 'X', mode, guidance: '', action: { type: 'ai.agent' as const, params: { agent } } }] });
  assert.throws(() => validatePlaybook(pb('AUTO'), app.kb.rules, app.kb.integrations, app.kb.agents), /mode must be REVIEW/);
  assert.throws(() => validatePlaybook(pb('REVIEW', 'nope'), app.kb.rules, app.kb.integrations, app.kb.agents), /unknown agent "nope"/);
  assert.doesNotThrow(() => validatePlaybook(pb('REVIEW'), app.kb.rules, app.kb.integrations, app.kb.agents));
});

test('schema helper: structured-output rules and value validation', () => {
  assert.deepEqual(checkSchema({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false }), ['$: every property must be required (missing a)']);
  const s = { type: 'object' as const, properties: { n: { type: 'integer' as const }, c: { type: 'string' as const, enum: ['high', 'low'] } }, required: ['n', 'c'], additionalProperties: false };
  assert.deepEqual(validate({ n: 2, c: 'high' }, s), []);
  assert.deepEqual(validate({ n: 2.5, c: 'mid', x: 1 }, s), ['$.n: expected integer, got number', '$.c: must be one of "high", "low"', '$.x: not allowed']);
});

// ------------------------------------------------------------ Claude implementation

test('claudeAgentModel: tool runner with strict read-only tools, structured output and fallbacks', async () => {
  let params: Record<string, unknown> = {};
  const toolRan: unknown[] = [];
  const messages = [
    { stop_reason: 'tool_use', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 100, output_tokens: 20 } },
    { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"answer":"ok"}' }], usage: { input_tokens: 150, output_tokens: 30 } },
  ];
  const stub = {
    beta: {
      messages: {
        toolRunner: (p: Record<string, unknown>) => {
          params = p;
          return {
            async *[Symbol.asyncIterator]() {
              // The real runner executes tools between messages.
              const tool = (p.tools as { run: (a: unknown) => Promise<string> }[])[0];
              toolRan.push(await tool.run({ q: 'x' }));
              for (const m of messages) yield m;
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  const model = claudeAgentModel(stub);
  const outSchema = { type: 'object' as const, properties: { answer: { type: 'string' as const } }, required: ['answer'], additionalProperties: false };
  const r = await model({
    system: 'sys',
    user: 'u',
    tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }, run: async () => ({ found: 1 }) }],
    outputSchema: outSchema,
    effort: 'medium',
    maxToolCalls: 3,
  });
  assert.deepEqual(r.output, { answer: 'ok' });
  assert.deepEqual(r.usage, { inputTokens: 250, outputTokens: 50 });
  assert.deepEqual(r.toolCalls, [{ tool: 'lookup', input: { q: 'x' }, ok: true }]);
  assert.deepEqual(toolRan, ['{"found":1}']);
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.max_iterations, 5);
  assert.deepEqual(params.output_config, { effort: 'medium', format: { type: 'json_schema', schema: outSchema } });
  assert.equal((params.tools as { strict: boolean }[])[0].strict, true);

  messages[1] = { stop_reason: 'refusal', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 0 }, stop_details: { category: 'cyber' } } as never;
  await assert.rejects(model({ system: 's', user: 'u', tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, run: async () => 1 }], outputSchema: outSchema, effort: 'low', maxToolCalls: 1 }), /declined.*cyber/);
});

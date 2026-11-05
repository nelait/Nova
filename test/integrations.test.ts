import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { IntegrationClient, type HttpRequest, type HttpResponse } from '../src/integrations/client.ts';
import { IntegrationRegistry, resolveEnv, type SystemDef } from '../src/integrations/registry.ts';
import { Collection, openDb } from '../src/store/db.ts';
import { validatePlaybook } from '../src/knowledge/knowledgeBase.ts';
import { NOW, installPlan, sampleDetails, testApp } from './helpers.ts';

const clock = { now: () => NOW };
const noSleep = async () => {};

function client(defs: SystemDef[], transport: (r: HttpRequest) => Promise<HttpResponse>, env: Record<string, string> = {}) {
  const reg = new IntegrationRegistry(undefined, env);
  defs.forEach((d) => reg.add(d, env));
  const log = new Collection(openDb(':memory:'), 'calls');
  return { c: new IntegrationClient(reg, log as never, clock, { transport, env, sleep: noSleep }), log };
}
const ok = (body: unknown, status = 200): HttpResponse => ({ status, body: JSON.stringify(body) });

// ------------------------------------------------------------ steps in a process

test('installation: integration step fetches fund data, rules check it, a person reviews', async () => {
  const app = testApp();
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const step = (id: string) => app.cases.tasksFor(kase.id).find((t) => t.stepId === id)!;

  const fetch = step('fetch-fund-data');
  assert.equal(fetch.status, 'DONE');
  const data = (fetch.result as { data: { funds: { ticker: string; available: boolean }[]; asOf: string } }).data;
  assert.deepEqual(data.funds.map((f) => f.ticker), ['VFIAX', 'VBTLX', 'VTTSX']);
  assert.equal(data.asOf, '2026-11-01');
  assert.equal(step('check-fund-availability').status, 'DONE');
  assert.equal(step('review-fund-lineup').assigneeId, 'u_sam');

  const calls = app.integrations.calls();
  assert.ok(calls.some((c) => c.system === 'fund-catalog' && c.operation === 'lookupFunds' && c.ok && c.caseId === kase.id && c.taskId === fetch.id));
});

test('a closed fund stops the lineup at the rules step and goes to a person', async () => {
  const app = testApp();
  const funds = [...sampleDetails().funds, { ticker: 'XCLSX', name: 'Example Closed Growth Fund' }, { ticker: 'NOPEX', name: 'Typo fund' }];
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ funds }) } }, 'portal');
  const check = app.cases.tasksFor(kase.id).find((t) => t.stepId === 'check-fund-availability')!;
  assert.match(check.exception!, /does not recognise: NOPEX/);
  assert.match(check.exception!, /Closed to new plans \(XCLSX\)/);
  assert.ok(check.assigneeId, 'routed to an INVESTMENTS user');
  assert.equal(app.cases.tasksFor(kase.id).find((t) => t.stepId === 'review-fund-lineup')!.status, 'BLOCKED');
});

test('catalog outage: the integration step becomes an exception; retry succeeds once it is back', async () => {
  const app = testApp();
  app.integrations.registerMock('fund-catalog', () => ({ status: 503, body: '{"error":"down for maintenance"}' }));
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const fetch = app.cases.tasksFor(kase.id).find((t) => t.stepId === 'fetch-fund-data')!;
  assert.match(fetch.exception!, /fund-catalog\.lookupFunds: 503 down for maintenance \(after 2 attempts\)/);

  const { fundCatalogHandler } = await import('../src/integrations/fundCatalog.ts');
  app.integrations.registerMock('fund-catalog', fundCatalogHandler);
  await app.cases.completeTask(fetch.id, fetch.assigneeId!); // "Retry"
  assert.equal(app.repos.tasks.require(fetch.id).status, 'DONE');
  assert.equal(app.cases.tasksFor(kase.id).find((t) => t.stepId === 'check-fund-availability')!.status, 'DONE');
});

test('a single TRAC hiccup is absorbed by the retry policy', async () => {
  const app = testApp();
  const { case: kase } = await app.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const open = () => app.cases.tasksFor(kase.id).filter((t) => t.stepId !== 'trac-install' && (t.status === 'READY' || t.status === 'IN_PROGRESS'));
  while (open().length) for (const t of open()) await app.cases.completeTask(t.id, t.assigneeId!);
  const install = app.cases.tasksFor(kase.id).find((t) => t.stepId === 'trac-install')!;
  app.trac.failNext(1);
  assert.equal((await app.cases.completeTask(install.id, install.assigneeId!)).status, 'DONE');
  const call = app.integrations.calls().find((c) => c.operation === 'installPlan')!;
  assert.equal(call.attempts, 2);
  assert.equal(app.trac.listPlans().length, 1, 'idempotency key prevents a duplicate plan');
});

test('maintenance reads current data from TRAC through the integration', async () => {
  const app = testApp();
  const { plan } = await installPlan(app);
  await app.cases.submitIntake({ caseType: 'MAINTENANCE_FEES', channel: 'DIGITAL', planId: plan.id, data: { fees: { recordkeepingBps: 6, perParticipantUsd: 35, terminationBaseUsd: 2500 } } }, 'portal');
  assert.ok(app.integrations.calls().some((c) => c.system === 'trac' && c.operation === 'getPlan' && c.path === `/plans/${plan.tracPlanId}`));
});

// ------------------------------------------------------------ the real HTTP path

test('real endpoint: request built from config with secret header, idempotency key and mapped body', async () => {
  const sent: HttpRequest[] = [];
  const transport = async (r: HttpRequest): Promise<HttpResponse> => {
    sent.push(r);
    if (r.method === 'POST' && r.url.endsWith('/plans')) return ok({ id: 'TRAC-9', version: 1 }, 201);
    return ok({ status: 'ok' });
  };
  const app = createApp({
    dbPath: ':memory:',
    seedUsers: true,
    clock,
    aiModel: null,
    sleep: noSleep,
    transport,
    env: { TRAC_BASE_URL: 'https://trac.example.com/api', TRAC_API_KEY: 'k-123' },
  });
  await installPlan(app);
  const post = sent.find((r) => r.method === 'POST' && r.url === 'https://trac.example.com/api/plans')!;
  assert.ok(post, 'install went to the configured TRAC URL');
  assert.equal(post.headers['x-api-key'], 'k-123');
  assert.match(post.headers['idempotency-key'], /^case_\w+:trac-install$/);
  const body = JSON.parse(post.body!);
  assert.deepEqual(body.sponsor, { name: 'Acme Robotics Inc.', ein: '12-3456789' });
  assert.equal(body.participants, 250);
  assert.equal(app.trac.listPlans().length, 0, 'the mock was not used');
  const entry = app.integrations.calls().find((c) => c.operation === 'installPlan')!;
  assert.deepEqual(Object.keys(entry).sort(), ['actor', 'at', 'attempts', 'caseId', 'durationMs', 'id', 'method', 'ok', 'operation', 'path', 'status', 'system', 'taskId']);
  assert.ok(!JSON.stringify(app.integrations.calls()).includes('k-123'), 'secrets never logged');
});

test('real endpoint without its secret fails clearly instead of calling unauthenticated', async () => {
  const app = createApp({ dbPath: ':memory:', seedUsers: true, clock, aiModel: null, sleep: noSleep, transport: async () => ok({}), env: { TRAC_BASE_URL: 'https://trac.example.com' } });
  const s = app.kb.integrations.system('trac');
  assert.deepEqual(app.integrations.secretStatus(s), [{ env: 'TRAC_API_KEY', set: false }]);
  await assert.rejects(app.integrations.call('trac', 'listPlans'), /secret TRAC_API_KEY is not set/);
});

const SYS = (over: Partial<SystemDef> = {}): SystemDef => ({
  id: 'crm',
  name: 'CRM',
  baseUrl: 'https://crm.example.com',
  retry: { attempts: 3, backoffMs: 1 },
  operations: {
    get: { method: 'GET', path: '/accounts/{{input.id}}', response: { name: 'response.accountName' } },
    create: { method: 'POST', path: '/accounts', body: { name: '=input.name' } },
  },
  ...over,
});

test('client: response mapping, URL-encoded path values, no retry for non-idempotent writes', async () => {
  const urls: string[] = [];
  let posts = 0;
  const { c } = client([SYS()], async (r) => {
    urls.push(r.url);
    if (r.method === 'POST') return posts++, { status: 503, body: '{}' };
    return ok({ accountName: 'Acme' });
  });
  const r = await c.call('crm', 'get', { input: { id: '../admin?x=1' } });
  assert.deepEqual(r.data, { name: 'Acme' });
  assert.equal(urls[0], 'https://crm.example.com/accounts/..%2Fadmin%3Fx%3D1');
  await assert.rejects(c.call('crm', 'create', { input: { name: 'X' } }), /503/);
  assert.equal(posts, 1, 'a write that is not idempotent is never retried');
});

test('client: timeouts are reported and retried', async () => {
  let n = 0;
  const { c } = client([SYS({ timeoutMs: 20 })], (r) => {
    n++;
    return new Promise((_res, rej) => r.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  });
  await assert.rejects(c.call('crm', 'get', { input: { id: 1 } }), /timed out after 20 ms \(after 3 attempts\)/);
  assert.equal(n, 3);
});

test('client: OAuth2 client credentials token is fetched once, cached, and refreshed after a 401', async () => {
  const seen: string[] = [];
  let tokenCalls = 0;
  let reject = false;
  const { c } = client(
    [SYS({ auth: { type: 'oauth2ClientCredentials', tokenUrl: 'https://auth.example.com/token', clientIdEnv: 'CRM_ID', clientSecretEnv: 'CRM_SECRET', scope: 'accounts.read' } })],
    async (r) => {
      if (r.url.startsWith('https://auth.example.com')) {
        tokenCalls++;
        assert.match(r.body!, /grant_type=client_credentials&client_id=id1&client_secret=s1&scope=accounts.read/);
        return ok({ access_token: `tok${tokenCalls}`, expires_in: 3600 });
      }
      seen.push(r.headers.authorization);
      if (reject) return (reject = false), { status: 401, body: '{}' };
      return ok({ accountName: 'A' });
    },
    { CRM_ID: 'id1', CRM_SECRET: 's1' },
  );
  await c.call('crm', 'get', { input: { id: 1 } });
  await c.call('crm', 'get', { input: { id: 2 } });
  assert.equal(tokenCalls, 1);
  reject = true;
  await assert.rejects(c.call('crm', 'get', { input: { id: 3 } }), /401/);
  await c.call('crm', 'get', { input: { id: 4 } });
  assert.equal(tokenCalls, 2, 'token refreshed after 401');
  assert.deepEqual(seen, ['Bearer tok1', 'Bearer tok1', 'Bearer tok1', 'Bearer tok2']);
});

// ------------------------------------------------------------ configuration checks

test('integration configuration is checked at load', () => {
  const reg = new IntegrationRegistry();
  assert.throws(() => reg.add(SYS({ baseUrl: 'http://crm.example.com' })), /plain http is only allowed for localhost/);
  assert.throws(() => reg.add(SYS({ baseUrl: '${CRM_URL}' }), {}), /CRM_URL is not set/);
  assert.equal(resolveEnv('${X:-mock://x}', {}), 'mock://x');
  assert.throws(() => reg.add(SYS({ operations: { bad: { method: 'GET', path: '/a/{{nope.x}}' } } })), /Unknown name "nope"/);
  assert.throws(() => reg.add(SYS({ operations: { bad: { method: 'POST', path: '/a', body: { x: '=eval(1)' } } } })), /Unknown function "eval"/);
  assert.throws(() => reg.add(SYS({ healthCheck: 'missing' })), /healthCheck/);
});

test('playbooks are rejected if a step calls an unknown integration operation', () => {
  const app = testApp();
  const pb = { id: 'p', version: 1, caseType: 'INSTALLATION' as const, name: '', description: '', steps: [{ id: 's', name: 's', skill: 'X', mode: 'AUTO' as const, guidance: '', action: { type: 'integration.call' as const, params: { system: 'trac', operation: 'deletePlan' } } }] };
  assert.throws(() => validatePlaybook(pb, app.kb.rules, app.kb.integrations), /unknown integration operation "trac.deletePlan"/);
});

test('health check and admin listing', async () => {
  const app = testApp();
  const healthy = await app.integrations.test('trac');
  assert.equal(healthy.ok, true);
  assert.equal(healthy.message, 'Reachable (200)');
  app.trac.failNext(10);
  const down = await app.integrations.test('trac');
  assert.equal(down.ok, false);
  assert.match(down.message, /503/);
  app.trac.failNext(0);
  assert.equal((await app.integrations.test('fund-catalog')).ok, true);
  assert.equal(app.integrations.calls(2).length, 2, 'newest calls first, limited');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { scimToUser } from '../src/users/userDirectory.ts';
import { installPlan, sampleDetails } from './helpers.ts';

// Per-client access: Marcus works only the "default" client; Elena (supervisor)
// has clients.all; the "acme-premium" client's work must stay out of Marcus's view.
let app: App;
let server: Server;
let base: string;
let premium: { caseId: string; planId: string; tracPlanId: string };
let standard: { caseId: string; planId: string; tracPlanId: string };

before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null, sleep: async () => {} });
  const a = await installPlan(app, 'default');
  const b = await installPlan(app, 'acme-premium', sampleDetails({ sponsorName: 'Quill & Ink Publishing', ein: '27-5530918' }));
  standard = { caseId: a.kase.id, planId: a.plan.id, tracPlanId: a.plan.tracPlanId! };
  premium = { caseId: b.kase.id, planId: b.plan.id, tracPlanId: b.plan.tracPlanId! };
  // Someone who reads the audit log but only for the default client.
  app.users.import([{ id: 'u_ua', name: 'Uma Admin', email: 'uma@planops.example', roles: ['user-admin'], clients: ['default'] }], 'test');
  server = startServer(app, 0, join(import.meta.dirname, '..', 'public'), { host: '127.0.0.1' });
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (as: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { 'x-user-id': as, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (as: string, path: string) => (await call(as, 'GET', path)).json();

test('lists show only your clients\' plans, cases, emails and calls', async () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  assert.ok(ids(await json('u_marcus', '/api/cases')).includes(standard.caseId));
  assert.ok(!ids(await json('u_marcus', '/api/cases')).includes(premium.caseId));
  assert.ok(ids(await json('u_elena', '/api/cases')).includes(premium.caseId), 'clients.all sees everything');
  assert.ok(!ids(await json('u_marcus', '/api/plans')).includes(premium.planId));
  assert.deepEqual((await json('u_marcus', '/api/clients')).map((c: { clientId: string }) => c.clientId), ['default']);
  const mail = await json('u_marcus', '/api/outbox');
  assert.ok(mail.length > 0 && mail.every((m: { caseId: string }) => m.caseId !== premium.caseId));
  assert.ok((await json('u_elena', '/api/outbox')).some((m: { caseId: string }) => m.caseId === premium.caseId));
  const calls = await json('u_marcus', '/api/integrations/calls?limit=500');
  assert.ok(calls.length > 0 && calls.every((c: { caseId?: string }) => c.caseId && c.caseId !== premium.caseId), 'only calls made for your cases');
  const trac = (await json('u_marcus', '/api/trac/plans')).map((p: { id: string }) => p.id);
  assert.deepEqual(trac, [standard.tracPlanId]);
  const audit = await json('u_ua', '/api/audit?limit=5000');
  assert.ok(audit.some((e: { caseId?: string }) => e.caseId === standard.caseId));
  assert.ok(!audit.some((e: { caseId?: string; entityId: string }) => e.caseId === premium.caseId || e.entityId === premium.planId));
});

test('another client\'s case, plan or task is "not found", not "forbidden"', async () => {
  const premiumTask = app.cases.tasksFor(premium.caseId)[0];
  for (const path of [`/api/cases/${premium.caseId}`, `/api/plans/${premium.planId}`, `/api/tasks/${premiumTask.id}/guidance`, `/api/tasks/${premiumTask.id}/ai-assist`]) {
    assert.equal((await call('u_marcus', 'GET', path)).status, 404, path);
    assert.equal((await call('u_elena', 'GET', path)).status, 200, path);
  }
  const evaluate = await call('u_marcus', 'POST', '/api/rules/termination-fees/evaluate', { caseId: premium.caseId });
  assert.equal(evaluate.status, 404);
});

test('you can\'t start or change work for a client that isn\'t yours', async () => {
  const forPremium = await call('u_marcus', 'POST', '/api/intake', { caseType: 'INSTALLATION', channel: 'DIGITAL', clientId: 'acme-premium', data: { details: sampleDetails() } });
  assert.equal(forPremium.status, 403);
  assert.match((await forPremium.json()).error, /access to client acme-premium/);
  const changePremiumPlan = await call('u_marcus', 'POST', '/api/intake', { caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: premium.planId, data: { contact: { role: 'PAYROLL', name: 'X', email: 'x@quill.example' } } });
  assert.equal(changePremiumPlan.status, 404);
  const ok = await call('u_marcus', 'POST', '/api/intake', { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: '11-2223334' }) } });
  assert.equal(ok.status, 200);
});

test('routing only gives a client\'s tasks to people with access to that client', async () => {
  // Premium sponsor verification needs COMPLIANCE L2+: Elena (all clients) and Rafael
  // (default only) both qualify by skill. With Elena away, it waits rather than go to Rafael.
  const dev = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null, sleep: async () => {} });
  dev.users.setActive('u_elena', false);
  const { case: kase } = await dev.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', clientId: 'acme-premium', data: { details: sampleDetails() } }, 'portal');
  const verify = dev.cases.tasksFor(kase.id).find((t) => t.stepId === 'verify-sponsor')!;
  assert.equal(verify.status, 'READY');
  assert.equal(verify.assigneeId, undefined);
  assert.match(JSON.stringify(verify.history.at(-1)), /with access to client acme-premium/);
  assert.throws(() => dev.cases.reassign(verify.id, 'u_priya', 'u_rafael'), /doesn't have access to client acme-premium/);
  // The same step for a default-client plan goes to Rafael.
  const { case: std } = await dev.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails({ ein: '12-9999999' }) } }, 'portal');
  assert.equal(dev.cases.tasksFor(std.id).find((t) => t.stepId === 'verify-sponsor')!.assigneeId, 'u_rafael');

  // Over the API, someone without the client can't even find the task to move it.
  const premiumTask = app.cases.tasksFor(premium.caseId)[0];
  assert.equal((await call('u_marcus', 'POST', `/api/tasks/${premiumTask.id}/reassign`, {})).status, 404);
});

test('without client groups or clients.all you see no client\'s work', async () => {
  app.users.import([{ id: 'u_new', name: 'New Starter', email: 'new@planops.example', skills: [{ skill: 'MAINTENANCE', level: 3 }] }], 'test');
  assert.deepEqual(await json('u_new', '/api/cases'), []);
  assert.deepEqual(await json('u_new', '/api/clients'), []);
  assert.equal((await json('u_new', '/api/insights')).steps.reduce((n: number, s: { completed: number }) => n + s.completed, 0), 0);
});

test('insights only count your clients\' cases', async () => {
  const total = (i: { steps: { completed: number }[] }) => i.steps.reduce((n, s) => n + s.completed, 0);
  assert.ok(total(await json('u_marcus', '/api/insights')) < total(await json('u_elena', '/api/insights')));
});

test('client groups come from the identity provider', () => {
  const u = scimToUser({ userName: 'kai@planops.example', groups: [{ display: 'client:acme-premium' }, { display: 'client:default' }, { display: 'client:Bad Name' }] }, 'okta');
  assert.deepEqual(u.clients, ['acme-premium', 'default']);
});

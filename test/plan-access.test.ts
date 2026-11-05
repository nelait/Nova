import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { installPlan, sampleDetails } from './helpers.ts';
import type { User } from '../src/domain/types.ts';

// Per-plan access, on top of client access. All users here work the "default" client.
let app: App;
let server: Server;
let base: string;
let confidential: { planId: string; caseId: string };
let conflicted: { planId: string; caseId: string };

before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null, sleep: async () => {} });
  const a = await installPlan(app, 'default', sampleDetails({ sponsorName: 'Cedar Ridge Health Partners', ein: '82-4455120' }));
  const b = await installPlan(app, 'default', sampleDetails({ sponsorName: 'Tidewater Logistics Co.', ein: '61-7781203' }));
  confidential = { planId: a.plan.id, caseId: a.kase.id };
  conflicted = { planId: b.plan.id, caseId: b.kase.id };
  server = startServer(app, 0, join(import.meta.dirname, '..', 'public'), { host: '127.0.0.1' });
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (as: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { 'x-user-id': as, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (as: string, path: string) => (await call(as, 'GET', path)).json();
const sees = async (as: string, planId: string) => (await call(as, 'GET', `/api/plans/${planId}`)).status === 200;

test('allow and deny lists: who can see a plan', () => {
  const plan = { clientId: 'default', access: { allow: ['u_sam', 'u_marcus'], deny: ['u_marcus'] } };
  const u = (id: string, roles: string[] = [], clients = ['default']): User => ({ id, name: id, email: `${id}@x`, active: true, capacity: 5, skills: [], roles, clients, source: 't' });
  assert.equal(app.users.canAccessPlan(u('u_sam'), plan), true);
  assert.equal(app.users.canAccessPlan(u('u_marcus'), plan), false, 'deny beats allow');
  assert.equal(app.users.canAccessPlan(u('u_rafael'), plan), false, 'not on the allow list');
  assert.equal(app.users.canAccessPlan(u('u_rafael'), { clientId: 'default' }), true, 'no lists: everyone with the client');
  assert.equal(app.users.canAccessPlan(u('u_sam', [], ['acme-premium']), plan), false, 'the client still comes first');
  assert.equal(app.users.canAccessPlan(u('u_olivia', ['auditor'], []), plan), true, 'auditors see past the lists');
  assert.equal(app.users.canAccessPlan(u('u_elena', ['supervisor'], []), plan), false, 'supervisors (all clients) are still bound by them');
});

test('only plans.restrict can set access, with a reason, and it is audited', async () => {
  const body = { allow: ['u_priya', 'u_sam', 'u_rafael'], note: 'Sponsor asked for a named team' };
  assert.equal((await call('u_elena', 'PUT', `/api/plans/${confidential.planId}/access`, body)).status, 403, 'supervisors can\'t');
  assert.equal((await call('u_priya', 'PUT', `/api/plans/${confidential.planId}/access`, { allow: ['u_sam'] })).status, 422, 'a reason is required');
  assert.equal((await call('u_priya', 'PUT', `/api/plans/${confidential.planId}/access`, { allow: ['u_nobody'], note: 'x' })).status, 422);
  assert.equal((await call('u_priya', 'PUT', `/api/plans/${confidential.planId}/access`, { allow: ['u_sam'], deny: ['u_sam'], note: 'x' })).status, 422);
  const ok = await call('u_priya', 'PUT', `/api/plans/${confidential.planId}/access`, body);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).access, { allow: ['u_priya', 'u_sam', 'u_rafael'], note: 'Sponsor asked for a named team' });
  const event = app.repos.audit.all().filter((e) => e.event === 'plan.access-changed').at(-1)!;
  assert.deepEqual([event.actor, event.entityId], ['u_priya', confidential.planId]);

  assert.equal((await call('u_priya', 'PUT', `/api/plans/${conflicted.planId}/access`, { deny: ['u_marcus'], note: 'Relative works for the sponsor' })).status, 200);
});

test('a restricted plan, its cases and tasks are "not found" for people not allowed', async () => {
  assert.equal(await sees('u_sam', confidential.planId), true);
  assert.equal(await sees('u_marcus', confidential.planId), false, 'not on the allow list');
  assert.equal(await sees('u_elena', confidential.planId), false, 'a supervisor with all clients is still not on it');
  assert.equal(await sees('u_olivia', confidential.planId), true, 'auditor');
  assert.equal(await sees('u_priya', confidential.planId), true);
  assert.equal(await sees('u_marcus', conflicted.planId), false, 'denied');
  assert.equal(await sees('u_rafael', conflicted.planId), true);

  assert.equal((await call('u_marcus', 'GET', `/api/cases/${confidential.caseId}`)).status, 404);
  const task = app.cases.tasksFor(confidential.caseId)[0];
  assert.equal((await call('u_marcus', 'GET', `/api/tasks/${task.id}/guidance`)).status, 404);
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  assert.ok(!ids(await json('u_marcus', '/api/cases')).includes(confidential.caseId));
  assert.ok(!ids(await json('u_marcus', '/api/cases')).includes(conflicted.caseId));
  assert.ok(ids(await json('u_rafael', '/api/cases')).includes(conflicted.caseId));
  assert.ok(!(await json('u_marcus', '/api/outbox')).some((m: { caseId: string }) => m.caseId === confidential.caseId));
  // No changes to the plan through a new request either.
  const change = await call('u_marcus', 'POST', '/api/intake', { caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: conflicted.planId, data: { contact: { role: 'PAYROLL', name: 'X', email: 'x@tidewater.example' } } });
  assert.equal(change.status, 404);
});

test('who is on the lists is shown only to people who manage access', async () => {
  const forSam = await json('u_sam', `/api/plans/${confidential.planId}`);
  assert.deepEqual(forSam.access, { restricted: true });
  const forRafael = await json('u_rafael', `/api/cases/${conflicted.caseId}`);
  assert.deepEqual(forRafael.plan.access, { restricted: true }, 'Marcus\'s conflict of interest is not revealed');
  assert.equal(forRafael.users, undefined);
  const forPriya = await json('u_priya', `/api/cases/${conflicted.caseId}`);
  assert.deepEqual(forPriya.plan.access.deny, ['u_marcus']);
  assert.ok(forPriya.users.some((u: { id: string }) => u.id === 'u_marcus'));
  assert.equal((await json('u_rafael', '/api/cases')).find((c: { id: string }) => c.id === conflicted.caseId).restricted, true);
});

test('routing respects plan access, and losing access hands open tasks back', async () => {
  // A maintenance request on the conflicted plan: Marcus (MAINTENANCE L3) must not get it.
  const { case: kase } = await app.cases.submitIntake({ caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: conflicted.planId, data: { contact: { role: 'PAYROLL', name: 'Luca Romano', email: 'luca@tidewater.example' } } }, 'portal');
  const assigned = app.cases.tasksFor(kase.id).filter((t) => t.assigneeId);
  assert.ok(assigned.length > 0);
  assert.ok(assigned.every((t) => t.assigneeId !== 'u_marcus'));
  const open = app.cases.tasksFor(kase.id).find((t) => t.status === 'READY' && t.assigneeId)!;

  // Now restrict the plan to exclude whoever holds that task: it goes back through routing.
  const holder = open.assigneeId!;
  const r = await call('u_priya', 'PUT', `/api/plans/${conflicted.planId}/access`, { deny: ['u_marcus', holder], note: 'Wider conflict' });
  assert.equal(r.status, 200);
  const after = app.repos.tasks.require(open.id);
  assert.notEqual(after.assigneeId, holder);
  assert.ok(after.history.some((h) => h.event === 'reassigned' && (h.detail as { reason?: string }).reason === 'lost access to the plan'));
  if (!after.assigneeId) assert.match(JSON.stringify(after.history.at(-1)), /this restricted plan/);
  // And nobody can hand it straight back to them (they have the skill, not the access).
  assert.throws(() => app.cases.reassign(open.id, 'u_priya', holder), /restricted plan/);
});

test('lifting the restriction opens the plan to everyone with the client again', async () => {
  assert.equal((await call('u_priya', 'PUT', `/api/plans/${confidential.planId}/access`, {})).status, 200);
  assert.equal(await sees('u_marcus', confidential.planId), true);
  assert.equal(app.repos.plans.require(confidential.planId).access, undefined);
});

test('if nobody allowed on the plan has the skill, the task waits rather than go to someone outside the list', async () => {
  const { plan } = await installPlan(app, 'default', sampleDetails({ sponsorName: 'Private Office LLC', ein: '13-5557779' }));
  // Allowed: Priya and Sam, neither of whom does compliance work.
  app.cases.setPlanAccess(plan.id, { allow: ['u_priya', 'u_sam'], note: 'Executive plan' }, 'u_priya');
  const { case: kase } = await app.cases.submitIntake({ caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: plan.id, data: { contact: { role: 'PAYROLL', name: 'P', email: 'p@private.example' } } }, 'portal');
  const compliance = app.cases.tasksFor(kase.id).filter((t) => t.skill === 'COMPLIANCE' && t.status === 'READY');
  assert.ok(compliance.length > 0);
  assert.ok(compliance.every((t) => !t.assigneeId), 'not given to Elena or Rafael');
  assert.match(JSON.stringify(compliance[0].history.at(-1)), /this restricted plan/);
});

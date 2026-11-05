import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { PERMISSIONS, RoleModel, type RolesConfig } from '../src/users/roles.ts';
import type { User } from '../src/domain/types.ts';
import { sampleDetails } from './helpers.ts';

const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'roles.json'), 'utf8')) as RolesConfig;
const person = (roles: string[], active = true): User => ({ id: 'u_x', name: 'X', email: 'x@example.com', active, capacity: 5, skills: [], roles, source: 'test' });

test('roles add up, admin has everything, and read-only wins', () => {
  const m = new RoleModel(shipped);
  assert.deepEqual(m.permissions(person([])), ['cases.start', 'tasks.work', 'tasks.override'], 'everyone is a specialist');
  assert.deepEqual(m.permissions(person(['supervisor'])), ['cases.start', 'tasks.work', 'tasks.override', 'tasks.reassign', 'cases.cancel', 'plans.edit', 'audit.read', 'clients.all']);
  assert.ok(m.can(person(['user-admin']), 'users.manage') && !m.can(person(['user-admin']), 'cases.cancel'));
  assert.deepEqual(m.permissions(person(['admin'])), Object.keys(PERMISSIONS));
  assert.deepEqual(m.permissions(person(['admin', 'auditor'])), ['audit.read', 'clients.all'], 'an auditor who is also admin is read-only');
  assert.equal(m.canWork(person(['auditor'])), false);
  assert.deepEqual(m.permissions(person(['admin'], false)), [], 'deactivated people can do nothing');
  assert.deepEqual(m.rolesOf(person(['no-such-role'])), ['specialist'], 'unknown groups are ignored');
});

test('mistakes in roles.json stop the server starting, with a clear message', () => {
  assert.throws(() => new RoleModel({ defaultRoles: ['specialist'], roles: { specialist: { description: 'x', permissions: ['cases.delete'] } } }), /unknown permission "cases.delete"/);
  assert.throws(() => new RoleModel({ defaultRoles: ['everyone'], roles: {} }), /defaultRoles: no role named "everyone"/);
  assert.throws(() => new RoleModel({ defaultRoles: [], roles: { 'Team Lead': { description: 'x', permissions: [] } } }), /lowercase letters/);
  assert.throws(() => new RoleModel({ defaultRoles: [], roles: { lead: { description: '', permissions: [] } } }), /needs a description/);
});

// ---------------------------------------------------------------- over HTTP (development mode: x-user-id)
let app: App;
let server: Server;
let base: string;
before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null, sleep: async () => {} });
  server = startServer(app, 0, join(import.meta.dirname, '..', 'public'), { host: '127.0.0.1' });
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (as: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { 'x-user-id': as, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function openCase(): Promise<string> {
  const r = await call('u_marcus', 'POST', '/api/intake', { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } });
  assert.equal(r.status, 200);
  return (await r.json()).case.id;
}

test('/api/me reports roles and permissions; /api/roles describes them', async () => {
  const me = await (await call('u_elena', 'GET', '/api/me')).json();
  assert.deepEqual(me.user.roles, ['specialist', 'supervisor']);
  assert.ok(me.user.permissions.includes('cases.cancel'));
  const roles = await (await call('u_marcus', 'GET', '/api/roles')).json();
  assert.deepEqual(Object.keys(roles.roles), Object.keys(shipped.roles));
  assert.equal(roles.permissions['audit.read'], PERMISSIONS['audit.read']);
});

test('a supervisor can cancel cases, reassign anyone\'s task and read the audit log, but not manage users', async () => {
  const caseId = await openCase();
  const someoneElses = app.repos.tasks.find((t) => t.caseId === caseId && !!t.assigneeId && t.assigneeId !== 'u_elena' && t.assigneeId !== 'u_marcus')[0];
  assert.ok(someoneElses, 'a task routed to someone else');
  assert.equal((await call('u_marcus', 'POST', `/api/tasks/${someoneElses.id}/reassign`, {})).status, 403, 'a specialist can only hand back their own');
  assert.equal((await call('u_elena', 'POST', `/api/tasks/${someoneElses.id}/reassign`, {})).status, 200);
  assert.equal((await call('u_marcus', 'GET', '/api/audit')).status, 403);
  assert.equal((await call('u_elena', 'GET', '/api/audit')).status, 200);
  assert.equal((await call('u_elena', 'POST', '/api/users/u_sam/active', { active: false })).status, 403);
  const denied = await call('u_marcus', 'POST', `/api/cases/${caseId}/cancel`, { reason: 'x' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'This action needs the cases.cancel permission');
  assert.equal((await call('u_elena', 'POST', `/api/cases/${caseId}/cancel`, { reason: 'duplicate request' })).status, 200);
});

test('a user admin manages users only; an integration admin tests connections only', async () => {
  app.users.import([{ id: 'u_ua', name: 'Uma Admin', email: 'uma@planops.example', roles: ['user-admin'] }], 'test');
  assert.equal((await call('u_ua', 'POST', '/api/users/u_sam/active', { active: true })).status, 200);
  assert.equal((await call('u_ua', 'POST', '/api/integrations/trac/test', {})).status, 403);
  assert.equal((await call('u_dana', 'POST', '/api/integrations/trac/test', {})).status, 200);
  assert.equal((await call('u_dana', 'POST', '/api/users/u_sam/active', { active: true })).status, 403);
  const caseId = await openCase();
  assert.equal((await call('u_ua', 'POST', `/api/cases/${caseId}/cancel`, { reason: 'x' })).status, 403);
});

test('removing a permission from a role takes effect everywhere it is checked', async () => {
  // An organization that only lets supervisors override failed automatic steps.
  const strict: RolesConfig = structuredClone(shipped);
  strict.roles.specialist.permissions = ['cases.start', 'tasks.work'];
  strict.roles.supervisor.permissions.push('tasks.override');
  Object.assign(app.users, { roles: new RoleModel(strict) });
  try {
    const caseId = await openCase();
    // A task owned by a plain specialist (not Priya the admin or Elena the supervisor).
    const task = app.repos.tasks.find((t) => t.caseId === caseId && !!t.assigneeId && !['u_priya', 'u_elena'].includes(t.assigneeId))[0];
    assert.ok(task, 'a task owned by a specialist');
    const r = await call(task.assigneeId!, 'POST', `/api/tasks/${task.id}/complete`, { override: true, notes: 'skip it' });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /tasks\.override/);
    const me = await (await call('u_marcus', 'GET', '/api/me')).json();
    assert.equal(me.user.permissions.includes('tasks.override'), false);
  } finally {
    Object.assign(app.users, { roles: new RoleModel(shipped) });
  }
});

test('people without tasks.work are never routed work', async () => {
  const noWork: RolesConfig = structuredClone(shipped);
  noWork.defaultRoles = [];
  noWork.roles.intake = { description: 'Client services: start requests only', permissions: ['cases.start'] };
  const dev = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null });
  Object.assign(dev.users, { roles: new RoleModel(noWork) });
  // Rafael has the compliance skill but an intake-only role; Elena, who could take the work, is away.
  dev.users.import([{ id: 'u_rafael', name: 'Rafael Torres', email: 'rafael@planops.example', roles: ['intake'], skills: [{ skill: 'COMPLIANCE', level: 3 }] }], 'seed');
  dev.users.setActive('u_elena', false);
  await dev.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const compliance = dev.repos.tasks.find((t) => t.skill === 'COMPLIANCE' && t.status === 'READY');
  assert.ok(compliance.length > 0);
  assert.ok(compliance.every((t) => !t.assigneeId), 'waits in the unassigned queue rather than going to Rafael');
  assert.throws(() => dev.cases.reassign(compliance[0].id, 'u_priya', 'u_rafael'), /can't be given tasks/);
});

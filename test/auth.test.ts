import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { MockIdp } from '../src/auth/mockIdp.ts';
import { OidcClient, oidcConfigFromEnv } from '../src/auth/oidc.ts';
import { safeReturnTo } from '../src/auth/auth.ts';
import { sampleDetails } from './helpers.ts';

const ISSUER = 'https://idp.example.test';
const PUBLIC = join(import.meta.dirname, '..', 'public');
const SSO_ENV = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'plan-ops', OIDC_REDIRECT_URI: 'https://ops.example.test/auth/callback' };

const idp = new MockIdp({
  issuer: ISSUER,
  clientId: 'plan-ops',
  people: [
    { email: 'priya@planops.example', name: 'Priya Shah' },
    { email: 'marcus@planops.example', name: 'Marcus Lee' },
    { email: 'stranger@elsewhere.example', name: 'Not Provisioned' },
    { email: 'sam@planops.example', name: 'Sam Okafor', emailVerified: false },
    { email: 'olivia@planops.example', name: 'Olivia Grant' },
  ],
});

let app: App;
let server: Server;
let base: string;

async function listen(a: App): Promise<{ server: Server; base: string }> {
  const s = startServer(a, 0, PUBLIC, { host: '127.0.0.1' });
  await new Promise((ok) => s.once('listening', ok));
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: SSO_ENV, oidcTransport: idp.transport, aiModel: null, agentModel: null });
  ({ server, base } = await listen(app));
});
after(() => server.close());

const get = (path: string, cookie = '', headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', headers: { cookie, ...headers } });
const post = (path: string, cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(name + '='));
const asCookie = (setCookie: string | undefined) => (setCookie ?? '').split(';')[0];

/** Runs the whole browser flow and returns the session cookie. */
async function signIn(email: string, returnTo = '/'): Promise<{ cookie: string; callback: Response }> {
  const start = await get(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302);
  const loginCookie = asCookie(cookieValue(start, 'planops_login'));
  const back = new URL(idp.authorize(start.headers.get('location')!, email));
  const callback = await get(back.pathname + back.search, loginCookie);
  return { cookie: asCookie(cookieValue(callback, 'planops_session')), callback };
}

test('API needs a session; signing in through the identity provider creates one', async () => {
  const anon = await get('/api/me');
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).signIn, '/auth/login');

  const start = await get('/auth/login?returnTo=/cases');
  const to = new URL(start.headers.get('location')!);
  assert.equal(to.origin + to.pathname, `${ISSUER}/authorize`);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('nonce') && to.searchParams.get('state'));
  assert.match(cookieValue(start, 'planops_login')!, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);

  const { cookie, callback } = await signIn('Priya@PlanOps.example', '/cases');
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/cases');
  assert.match(cookieValue(callback, 'planops_session')!, /HttpOnly; SameSite=Lax; Max-Age=28800; Secure/);
  const me = await (await get('/api/me', cookie)).json();
  assert.equal(me.mode, 'oidc');
  assert.equal(me.user.id, 'u_priya');
  assert.deepEqual(me.user.roles, ['admin']);
  assert.ok(app.repos.audit.all().some((e) => e.event === 'user.signed-in' && e.actor === 'u_priya'));
});

test('with single sign-on the x-user-id header is ignored', async () => {
  const { cookie } = await signIn('marcus@planops.example');
  const me = await (await get('/api/me', cookie, { 'x-user-id': 'u_priya' })).json();
  assert.equal(me.user.id, 'u_marcus');
  assert.equal((await get('/api/me', '', { 'x-user-id': 'u_priya' })).status, 401);
});

test('admin-only actions need the admin role', async () => {
  const marcus = (await signIn('marcus@planops.example')).cookie;
  const priya = (await signIn('priya@planops.example')).cookie;
  const scim = { source: 'okta', Resources: [{ id: '77', userName: 'kai@planops.example', groups: [{ display: 'skill:INVESTMENTS:2' }] }] };
  assert.equal((await post('/api/users/import/scim', marcus, scim)).status, 403);
  assert.equal((await post('/api/users/u_sam/active', marcus, { active: false })).status, 403);
  assert.equal((await post('/api/users/import/scim', priya, scim)).status, 200);
  // The mock-TRAC outage switch is a demo aid and doesn't exist with single sign-on.
  assert.equal((await post('/api/trac/simulate-outage', priya, {})).status, 404);
});

test('requests that change data must be same-origin JSON', async () => {
  const { cookie } = await signIn('priya@planops.example');
  const form = await fetch(base + '/api/users/u_sam/active', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{"active":false}' });
  assert.equal(form.status, 403);
  assert.equal((await post('/api/users/u_sam/active', cookie, { active: false }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(app.users.get('u_sam')!.active, true);
});

test('the callback only works once, in the browser that started sign-in', async () => {
  const start = await get('/auth/login');
  const loginCookie = asCookie(cookieValue(start, 'planops_login'));
  const back = new URL(idp.authorize(start.headers.get('location')!, 'priya@planops.example'));
  // Someone else's browser (no matching state cookie) can't use the link.
  assert.equal((await get(back.pathname + back.search, 'planops_login=other')).status, 400);
  assert.equal((await get(back.pathname + back.search)).status, 400);
  // The right browser can, once.
  assert.equal((await get(back.pathname + back.search, loginCookie)).status, 302);
  assert.equal((await get(back.pathname + back.search, loginCookie)).status, 400);
});

test('people not in the directory, unverified emails and deactivated users are refused', async () => {
  const stranger = await signIn('stranger@elsewhere.example');
  assert.equal(stranger.callback.status, 403);
  assert.equal(stranger.cookie, '');
  assert.match(await stranger.callback.text(), /not set up in Plan Ops Hub/);
  assert.ok(app.repos.audit.all().some((e) => e.event === 'user.sign-in-refused' && e.entityId === 'stranger@elsewhere.example'));

  assert.equal((await signIn('sam@planops.example')).callback.status, 403);

  const { cookie } = await signIn('marcus@planops.example');
  app.users.setActive('u_marcus', false);
  assert.equal((await get('/api/me', cookie)).status, 401, 'deactivation ends access at once');
  assert.equal((await signIn('marcus@planops.example')).callback.status, 403);
  app.users.setActive('u_marcus', true);
});

test('signing out ends the session', async () => {
  const { cookie } = await signIn('priya@planops.example');
  const out = await post('/auth/logout', cookie, {});
  assert.equal(out.status, 200);
  assert.match(cookieValue(out, 'planops_session')!, /Max-Age=0/);
  assert.equal((await get('/api/me', cookie)).status, 401);
  assert.ok(app.repos.audit.all().some((e) => e.event === 'user.signed-out'));
});

test('return addresses stay on this site', async () => {
  assert.equal(safeReturnTo('/cases?x=1'), '/cases?x=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/x\r\nSet-Cookie: a=b', undefined]) assert.equal(safeReturnTo(bad), '/');
  const { callback } = await signIn('priya@planops.example', '//evil.example/');
  assert.equal(callback.headers.get('location'), '/');
});

test('ID tokens are fully verified', async () => {
  const client = new OidcClient(oidcConfigFromEnv(SSO_ENV)!, idp.transport);
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: ISSUER, aud: 'plan-ops', sub: 'x', email: 'priya@planops.example', nonce: 'n1', iat: now, exp: now + 300 };
  assert.equal((await client.verifyIdToken(idp.idToken(good), 'n1')).email, 'priya@planops.example');

  const rejects = async (token: string, why: RegExp, nonce = 'n1') => assert.rejects(client.verifyIdToken(token, nonce), why);
  await rejects(idp.idToken(good), /nonce/, 'other');
  await rejects(idp.idToken({ ...good, aud: 'someone-else' }), /audience/);
  await rejects(idp.idToken({ ...good, iss: 'https://evil.example' }), /issuer/);
  await rejects(idp.idToken({ ...good, exp: now - 3600 }), /expired/);
  await rejects(idp.idToken({ ...good, nbf: now + 3600 }), /not valid yet/);
  const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejects(idp.idToken(good, forger), /signature/);
  await rejects(idp.idToken(good, forger, 'unknown-kid'), /unknown key/);
  const [h, b] = idp.idToken(good).split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'mock-1' })).toString('base64url');
  await rejects(`${none}.${b}.`, /not allowed/);
  await rejects(`${h}.${Buffer.from(JSON.stringify({ ...good, email: 'evil@x' })).toString('base64url')}.${idp.idToken(good).split('.')[2]}`, /signature/);
});

test('a token the provider signed for another audience does not sign anyone in', async () => {
  idp.claimOverrides = { aud: 'another-app' };
  try {
    const { callback, cookie } = await signIn('priya@planops.example');
    assert.equal(callback.status, 400);
    assert.equal(cookie, '');
  } finally {
    idp.claimOverrides = {};
  }
});

test('settings from the environment are checked', () => {
  assert.equal(oidcConfigFromEnv({}), undefined);
  assert.throws(() => oidcConfigFromEnv({ OIDC_ISSUER: ISSUER }), /OIDC_CLIENT_ID, OIDC_REDIRECT_URI are not set/);
  assert.throws(() => oidcConfigFromEnv({ ...SSO_ENV, OIDC_ISSUER: 'http://idp.example.test' }), /https/);
  assert.ok(oidcConfigFromEnv({ ...SSO_ENV, OIDC_ISSUER: 'http://localhost:3201' }));
});

test('development mode: localhost only, no sign-in routes, admin still enforced', async () => {
  const dev = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null });
  assert.throws(() => startServer(dev, 0, PUBLIC, { host: '0.0.0.0' }), /only listens on localhost/);
  const { server: s, base: b } = await listen(dev);
  try {
    assert.equal((await fetch(b + '/auth/login', { redirect: 'manual' })).status, 404);
    const me = await (await fetch(b + '/api/me', { headers: { 'x-user-id': 'u_marcus' } })).json();
    assert.deepEqual([me.mode, me.user.id], ['dev', 'u_marcus']);
    const asUser = (id: string) => fetch(b + '/api/trac/simulate-outage', { method: 'POST', headers: { 'x-user-id': id, 'content-type': 'application/json' }, body: '{"requests":0}' });
    assert.equal((await asUser('u_marcus')).status, 403);
    assert.equal((await asUser('u_priya')).status, 200);
  } finally {
    s.close();
  }
});

test('auditors can read everything but change nothing', async () => {
  const { cookie } = await signIn('olivia@planops.example');
  const me = await (await get('/api/me', cookie)).json();
  assert.deepEqual([me.user.roles, me.user.readOnly, me.user.admin], [['auditor'], true, false]);
  for (const path of ['/api/cases', '/api/plans', '/api/audit', '/api/users', '/api/integrations/calls', '/api/outbox', '/api/insights', '/api/rules']) {
    assert.equal((await get(path, cookie)).status, 200, path);
  }
  // Rule tests and evaluation compute an answer without changing anything.
  assert.equal((await post('/api/rules/fee-change/test', cookie, {})).status, 200);
  const before = app.repos.cases.all().length;
  const intake = await post('/api/intake', cookie, { caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } });
  assert.equal(intake.status, 403);
  assert.equal((await intake.json()).error, 'Auditors have read-only access');
  assert.equal(app.repos.cases.all().length, before);
  assert.equal((await post('/api/tasks/any/complete', cookie, {})).status, 403);
  // Signing out is still allowed.
  assert.equal((await post('/auth/logout', cookie, {})).status, 200);
});

test('read-only wins: an auditor who is also an admin is still read-only', async () => {
  const dev = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null });
  dev.users.import([{ id: 'u_both', name: 'Both Roles', email: 'both@planops.example', roles: ['auditor', 'admin'] }], 'test');
  const { server: s, base: b } = await listen(dev);
  try {
    const res = await fetch(b + '/api/users/u_sam/active', { method: 'POST', headers: { 'x-user-id': 'u_both', 'content-type': 'application/json' }, body: '{"active":false}' });
    assert.equal(res.status, 403);
    assert.equal(dev.users.get('u_sam')!.active, true);
  } finally {
    s.close();
  }
});

test('auditors are never routed work, even with matching skills', async () => {
  const dev = createApp({ dbPath: ':memory:', seedUsers: true, env: {}, aiModel: null, agentModel: null });
  // Everyone else who could do compliance work is away; an auditor holds the skill.
  for (const id of ['u_elena', 'u_rafael']) dev.users.setActive(id, false);
  dev.users.import([{ id: 'u_aud', name: 'Ann Auditor', email: 'ann@planops.example', roles: ['auditor'], skills: [{ skill: 'COMPLIANCE', level: 3 }] }], 'test');
  await dev.cases.submitIntake({ caseType: 'INSTALLATION', channel: 'DIGITAL', data: { details: sampleDetails() } }, 'portal');
  const compliance = dev.repos.tasks.all().filter((t) => t.skill === 'COMPLIANCE');
  assert.ok(compliance.length > 0);
  assert.ok(compliance.every((t) => t.assigneeId !== 'u_aud'));
  const waiting = compliance.find((t) => t.status === 'READY')!;
  assert.throws(() => dev.cases.reassign(waiting.id, 'u_priya', 'u_aud'), /auditor/);
});

test('the audit log filters and downloads as CSV that is safe to open in a spreadsheet', async () => {
  const { cookie } = await signIn('olivia@planops.example');
  app.cases.audit('u_priya', 'user', 'u_x', 'test.formula', { note: '=HYPERLINK("http://evil")' });
  const rows = await (await get('/api/audit?event=user.signed-in&actor=u_olivia', cookie)).json();
  assert.ok(rows.length > 0 && rows.every((r: { event: string; actor: string }) => r.event === 'user.signed-in' && r.actor === 'u_olivia'));
  const csv = await get('/api/audit?format=csv&event=test.formula', cookie);
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(csv.headers.get('content-disposition')!, /attachment/);
  const lines = (await csv.text()).trim().split('\r\n');
  assert.equal(lines[0], 'at,actor,event,entity,entityId,caseId,detail');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"test.formula"'));
  assert.ok(!/,"=/.test(lines[1]), 'no cell starts with =');
  const future = await (await get('/api/audit?from=2999-01-01', cookie)).json();
  assert.deepEqual(future, []);
});

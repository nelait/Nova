import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { MockSamlIdp, type SamlResponseOptions } from '../src/auth/mockSamlIdp.ts';

// IdP-initiated sign-in (the app tile in Okta's dashboard or Microsoft My Apps),
// turned on with SAML_ALLOW_IDP_INITIATED. Off by default: test/saml.test.ts
// checks unsolicited responses are refused there.
const ACS = 'https://ops.example.test/auth/saml/acs';
const SP = { acsUrl: ACS, entityId: 'https://ops.example.test/auth/saml/metadata' };
const idp = new MockSamlIdp({
  entityId: 'https://idp.example.test/saml',
  ssoUrl: 'https://idp.example.test/sso',
  people: [
    { email: 'priya@planops.example', name: 'Priya Shah' },
    { email: 'marcus@planops.example', name: 'Marcus Lee' },
  ],
});
const ENV = { SAML_IDP_SSO_URL: idp.ssoUrl, SAML_IDP_ENTITY_ID: idp.entityId, SAML_IDP_CERT: idp.certPem, SAML_ACS_URL: ACS, SAML_ALLOW_IDP_INITIATED: 'true' };

let app: App;
let server: Server;
let base: string;
let host: string;

before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: ENV, aiModel: null, agentModel: null });
  server = startServer(app, 0, join(import.meta.dirname, '..', 'public'), { host: '127.0.0.1' });
  await new Promise((ok) => server.once('listening', ok));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});
after(() => server.close());

const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(name + '='));
const asCookie = (c: string | undefined) => (c ?? '').split(';')[0];
const join2 = (...c: string[]) => c.filter(Boolean).join('; ');

function postAcs(form: { SAMLResponse: string; RelayState: string }, cookie = ''): Promise<Response> {
  const body = new URLSearchParams({ SAMLResponse: form.SAMLResponse, ...(form.RelayState ? { RelayState: form.RelayState } : {}) });
  return fetch(`${base}/auth/saml/acs`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.test', cookie },
    body: body.toString(),
  });
}
/** The person clicks a button on the confirmation page (same-origin form post). */
function confirm(action: 'continue' | 'cancel', cookie: string, origin = base): Promise<Response> {
  return fetch(`${base}/auth/saml/${action}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie }, body: '' });
}
const me = async (cookie: string) => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user?.id;

/** Clicking the app tile: unsolicited response → confirmation page. */
async function launch(email: string, opts: SamlResponseOptions & { relayState?: string } = {}, cookie = '') {
  const page = await postAcs(idp.unsolicited(SP, email, opts), cookie);
  return { page, pending: asCookie(setCookie(page, 'planops_idp_signin')), session: asCookie(setCookie(page, 'planops_session')) };
}

test('opening the app from the IdP asks "Continue as …?" before signing in', async () => {
  const { page, pending, session } = await launch('priya@planops.example', { relayState: '/cases' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Continue to Plan Ops Hub\?/);
  assert.match(html, /signing you in as Priya Shah \(priya@planops\.example\)/);
  assert.equal(session, '', 'no session yet');
  assert.match(setCookie(page, 'planops_idp_signin')!, /HttpOnly; SameSite=Lax; Max-Age=120/);

  const done = await confirm('continue', pending);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/cases', 'RelayState is the landing page');
  const cookie = asCookie(setCookie(done, 'planops_session'));
  assert.equal(await me(cookie), 'u_priya');
  const audit = app.repos.audit.all().filter((e) => e.event === 'user.signed-in' && e.actor === 'u_priya').at(-1)!;
  assert.deepEqual(audit.detail, { via: 'saml', idpInitiated: true });
  // The confirmation is single use.
  assert.equal((await confirm('continue', pending)).status, 400);
});

test('login CSRF: someone else\'s assertion posted into your browser can\'t be completed without you', async () => {
  // The attacker posts their own valid assertion from their server and gets the page...
  const attacker = await launch('marcus@planops.example');
  const pendingFromAttackersServer = attacker.pending;
  // ...but can only make your browser confirm cross-site, which is refused.
  assert.equal((await confirm('continue', pendingFromAttackersServer, 'https://evil.example')).status, 403);
  assert.equal((await fetch(`${base}/auth/saml/continue`, { method: 'POST', redirect: 'manual', headers: { cookie: pendingFromAttackersServer } })).status, 403, 'no Origin');
  // And from your browser, without the cookie set with that page, there's nothing to confirm.
  assert.equal((await confirm('continue', '')).status, 400);
  // If the attacker auto-posts the assertion in your browser, you see whose account it is and can cancel.
  const victim = await launch('marcus@planops.example');
  assert.match(await victim.page.text(), /Marcus Lee/);
  const cancelled = await confirm('cancel', victim.pending);
  assert.equal(cancelled.status, 200);
  assert.equal((await confirm('continue', victim.pending)).status, 400, 'cancelled for good');
});

test('already signed in: same person goes straight in; a different person must confirm switching', async () => {
  const first = await launch('priya@planops.example');
  const session = asCookie(setCookie(await confirm('continue', first.pending), 'planops_session'));
  const again = await postAcs(idp.unsolicited(SP, 'priya@planops.example', { relayState: '/x' }), session);
  assert.equal(again.status, 303);
  assert.equal(again.headers.get('location'), '/x');
  const other = await launch('marcus@planops.example', {}, session);
  assert.match(await other.page.text(), /You're signed in as Priya Shah\. .*Marcus Lee .*Switch to that account\?/);
  assert.equal(await me(session), 'u_priya', 'still Priya until confirmed');
});

test('unsolicited assertions are single use, fresh, and land only on this site', async () => {
  const response = idp.unsolicited(SP, 'priya@planops.example');
  assert.equal((await postAcs(response)).status, 200);
  assert.equal((await postAcs(response)).status, 400, 'replayed');
  assert.equal((await launch('priya@planops.example', { issuedAgoSeconds: 600, validFor: 600 })).page.status, 400, 'issued 10 minutes ago');
  const offsite = await launch('priya@planops.example', { relayState: '//evil.example/' });
  assert.equal((await confirm('continue', offsite.pending)).headers.get('location'), '/');
});

test('a captured SP-initiated response can\'t be passed off as unsolicited by stripping InResponseTo', async () => {
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const authUrl = start.headers.get('location')!;
  // The Response element isn't signed; the assertion inside it is.
  const stripped = idp.respond(authUrl, 'priya@planops.example', { tamper: (x) => x.replace(/(<samlp:Response[^>]*?) InResponseTo="[^"]*"/, '$1') });
  const r = await postAcs({ SAMLResponse: stripped.SAMLResponse, RelayState: '' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /disagree about which request/);
});

test('SP-initiated sign-in still works, and an unsolicited assertion slipped into it needs confirming', async () => {
  const start = await fetch(`${base}/auth/login?returnTo=/rules`, { redirect: 'manual' });
  const loginCookie = asCookie(setCookie(start, 'planops_login'));
  const authUrl = start.headers.get('location')!;
  const ok = await postAcs(idp.respond(authUrl, 'marcus@planops.example'), loginCookie);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/rules');

  const start2 = await fetch(`${base}/auth/login?returnTo=/rules`, { redirect: 'manual' });
  const relay = idp.parseRequest(start2.headers.get('location')!).relayState;
  const injected = idp.unsolicited(SP, 'priya@planops.example', { relayState: relay });
  const r = await postAcs(injected, join2(asCookie(setCookie(start2, 'planops_login'))));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Continue to Plan Ops Hub\?/);
  assert.equal(asCookie(setCookie(r, 'planops_session')), '');
});

test('people the IdP knows but Plan Ops Hub does not are refused before any confirmation', async () => {
  const r = await postAcs(idp.unsolicited(SP, 'stranger@elsewhere.example'));
  assert.equal(r.status, 403);
  assert.equal(setCookie(r, 'planops_idp_signin'), undefined);
});

test('a response to someone else\'s sign-in, posted without its state, is refused', async () => {
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const theirs = idp.respond(start.headers.get('location')!, 'priya@planops.example');
  const r = await postAcs({ SAMLResponse: theirs.SAMLResponse, RelayState: '' });
  assert.equal(r.status, 400);
  assert.equal(asCookie(setCookie(r, 'planops_session')), '');
});

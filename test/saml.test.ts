import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { MockSamlIdp, type SamlResponseOptions } from '../src/auth/mockSamlIdp.ts';
import { samlConfigFromEnv } from '../src/auth/saml.ts';

const ACS = 'https://ops.example.test/auth/saml/acs';
const idp = new MockSamlIdp({
  entityId: 'https://idp.example.test/saml',
  ssoUrl: 'https://idp.example.test/sso',
  people: [
    { email: 'priya@planops.example', name: 'Priya Shah' },
    { email: 'marcus@planops.example', name: 'Marcus Lee' },
    { email: 'olivia@planops.example', name: 'Olivia Grant' },
  ],
});
const SAML_ENV = { SAML_IDP_SSO_URL: idp.ssoUrl, SAML_IDP_ENTITY_ID: idp.entityId, SAML_IDP_CERT: idp.certPem, SAML_ACS_URL: ACS };

let app: App;
let server: Server;
let base: string;

before(async () => {
  app = createApp({ dbPath: ':memory:', seedUsers: true, env: SAML_ENV, aiModel: null, agentModel: null });
  server = startServer(app, 0, join(import.meta.dirname, '..', 'public'), { host: '127.0.0.1' });
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(name + '='));
const asCookie = (c: string | undefined) => (c ?? '').split(';')[0];

async function startLogin(returnTo = '/'): Promise<{ authUrl: string; loginCookie: string; res: Response }> {
  const res = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return { authUrl: res.headers.get('location')!, loginCookie: asCookie(setCookie(res, 'planops_login')), res };
}

function postAcs(form: { SAMLResponse: string; RelayState: string }, cookie: string): Promise<Response> {
  return fetch(`${base}/auth/saml/acs`, {
    method: 'POST',
    redirect: 'manual',
    // The IdP's page posts this cross-site: Origin is the IdP, not this app.
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.test', cookie },
    body: new URLSearchParams(form).toString(),
  });
}

/** Full browser flow; returns the ACS response and the session cookie (empty if refused). */
async function signIn(email: string, opts: SamlResponseOptions = {}, returnTo = '/') {
  const { authUrl, loginCookie } = await startLogin(returnTo);
  const acs = await postAcs(idp.respond(authUrl, email, opts), loginCookie);
  return { acs, cookie: asCookie(setCookie(acs, 'planops_session')) };
}
const whoAmI = async (cookie: string) => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user?.id;

test('SAML sign-in: request to the IdP, signed assertion back, session opened', async () => {
  const { authUrl, res } = await startLogin('/cases');
  const req = idp.parseRequest(authUrl);
  assert.ok(authUrl.startsWith(idp.ssoUrl + '?'));
  assert.equal(req.acsUrl, ACS);
  assert.equal(req.spEntityId, 'https://ops.example.test/auth/saml/metadata');
  // The response comes back as a cross-site POST, so the state cookie must be SameSite=None.
  assert.match(setCookie(res, 'planops_login')!, /SameSite=None; Max-Age=600; Secure/);

  const { acs, cookie } = await signIn('priya@planops.example', {}, '/cases');
  assert.equal(acs.status, 303);
  assert.equal(acs.headers.get('location'), '/cases');
  assert.match(setCookie(acs, 'planops_session')!, /HttpOnly; SameSite=Lax/);
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  assert.deepEqual([me.mode, me.user.id], ['saml', 'u_priya']);
  assert.ok(app.repos.audit.all().some((e) => e.event === 'user.signed-in' && e.actor === 'u_priya' && (e.detail as { via: string }).via === 'saml'));
});

test('roles apply as with OIDC: an auditor signed in by SAML is read-only', async () => {
  const { cookie } = await signIn('olivia@planops.example');
  const res = await fetch(base + '/api/intake', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('service provider metadata is published for the IdP administrator', async () => {
  const res = await fetch(base + '/auth/saml/metadata');
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /entityID="https:\/\/ops\.example\.test\/auth\/saml\/metadata"/);
  assert.match(xml, /AssertionConsumerService[^>]+Location="https:\/\/ops\.example\.test\/auth\/saml\/acs"/);
  assert.match(xml, /WantAssertionsSigned="true"/);
});

test('a changed assertion fails its signature check', async () => {
  // Marcus edits his own signed assertion to say he is Priya (an admin).
  const { acs, cookie } = await signIn('marcus@planops.example', { tamper: (x) => x.replaceAll('marcus@planops.example', 'priya@planops.example') });
  assert.equal(acs.status, 400);
  assert.equal(cookie, '');
  assert.match(await acs.text(), /SAML response was rejected/);
});

test('signature wrapping: an unsigned assertion next to a signed one is not trusted', async () => {
  const evil = (x: string) => {
    const signedStart = x.indexOf('<saml:Assertion');
    const forged = x.slice(signedStart, x.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length)
      .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
      .replaceAll('marcus@planops.example', 'priya@planops.example')
      .replace(/ID="[^"]+"/, 'ID="_forged"');
    return x.slice(0, signedStart) + forged + x.slice(signedStart);
  };
  const { acs, cookie } = await signIn('marcus@planops.example', { tamper: evil });
  if (cookie) assert.notEqual(await whoAmI(cookie), 'u_priya');
  else assert.equal(acs.status, 400);
});

test('unsigned assertions, untrusted keys, wrong issuer, audience, recipient or destination, and expired assertions are refused', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const cases: [string, SamlResponseOptions][] = [
    ['unsigned', { unsigned: true }],
    ['untrusted key', { signingKey: other }],
    ['wrong issuer', { issuer: 'https://evil.example/saml' }],
    ['wrong audience', { audience: 'https://another-app.example/saml' }],
    ['wrong recipient', { recipient: 'https://another-app.example/auth/saml/acs' }],
    ['wrong destination', { destination: 'https://another-app.example/auth/saml/acs' }],
    ['expired', { validFor: -600 }],
  ];
  for (const [why, opts] of cases) {
    const { acs, cookie } = await signIn('priya@planops.example', opts);
    assert.equal(acs.status, 400, why);
    assert.equal(cookie, '', why);
  }
});

test('responses must answer a request this browser made, once', async () => {
  // IdP-initiated (unsolicited) responses are refused.
  const unsolicited = await signIn('priya@planops.example', { inResponseTo: null });
  assert.equal(unsolicited.acs.status, 400);

  const a = await startLogin();
  const response = idp.respond(a.authUrl, 'priya@planops.example');
  // Without this browser's state cookie (login CSRF), it is refused...
  assert.equal((await postAcs(response, '')).status, 400);
  // ...without using up the right browser's sign-in, which then works once.
  assert.equal((await postAcs(response, a.loginCookie)).status, 303);
  assert.equal((await postAcs(response, a.loginCookie)).status, 400);

  // A captured response can't be replayed with a fresh sign-in either.
  const b = await startLogin();
  const good = idp.respond(b.authUrl, 'priya@planops.example');
  assert.equal((await postAcs(good, b.loginCookie)).status, 303);
  const c = await startLogin();
  assert.equal((await postAcs({ SAMLResponse: good.SAMLResponse, RelayState: idp.parseRequest(c.authUrl).relayState }, c.loginCookie)).status, 400);
});

test('people the IdP knows but Plan Ops Hub does not are refused', async () => {
  const { acs, cookie } = await signIn('stranger@elsewhere.example');
  assert.equal(acs.status, 403);
  assert.equal(cookie, '');
  assert.ok(app.repos.audit.all().some((e) => e.event === 'user.sign-in-refused' && (e.detail as { via: string }).via === 'saml'));
});

test('OIDC routes are not available in SAML mode, and the ACS only takes form posts', async () => {
  assert.equal((await fetch(base + '/auth/callback?code=x&state=y', { redirect: 'manual' })).status, 404);
  const json = await fetch(base + '/auth/saml/acs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(json.status, 400);
});

test('SAML settings are checked at startup', () => {
  assert.equal(samlConfigFromEnv({}), undefined);
  assert.throws(() => samlConfigFromEnv({ SAML_IDP_SSO_URL: idp.ssoUrl }), /SAML_IDP_ENTITY_ID, SAML_IDP_CERT, SAML_ACS_URL are not set/);
  assert.throws(() => samlConfigFromEnv({ ...SAML_ENV, SAML_ACS_URL: 'http://ops.example.test/auth/saml/acs' }), /SAML_ACS_URL must use https/);
  assert.throws(() => samlConfigFromEnv({ ...SAML_ENV, SAML_ACS_URL: 'https://ops.example.test/callback' }), /must end with \/auth\/saml\/acs/);
  assert.equal(samlConfigFromEnv({ ...SAML_ENV, SAML_SP_ENTITY_ID: 'urn:planops' })!.spEntityId, 'urn:planops');
  assert.throws(
    () => createApp({ dbPath: ':memory:', env: { ...SAML_ENV, OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'x', OIDC_REDIRECT_URI: 'https://ops.example.test/auth/callback' }, aiModel: null, agentModel: null }),
    /either OpenID Connect .* or SAML/,
  );
});

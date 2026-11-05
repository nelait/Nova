// `npm run demo`: an in-memory instance loaded with sample data.
// With ANTHROPIC_API_KEY set, "Ask Claude" calls Claude; otherwise it returns
// canned responses labeled as sample data.
// `npm run demo:sso` (OpenID Connect) and `npm run demo:saml` (SAML 2.0) also start
// a mock identity provider so you can try single sign-on end to end: pick who to
// sign in as on the provider's page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { claudeModelCall } from '../src/ai/claudeAssist.ts';
import { claudeAgentModel } from '../src/ai/agents.ts';
import { MockIdp } from '../src/auth/mockIdp.ts';
import { MockSamlIdp } from '../src/auth/mockSamlIdp.ts';
import { DemoClock, sampleAgentModel, sampleModel, seedDemo } from './demo-data.ts';

const port = Number(process.env.PORT ?? 3000);
const seedPeople = () => [
  ...(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'users.json'), 'utf8')) as { name: string; email: string }[]),
  { name: 'Someone not yet provisioned', email: 'new.hire@planops.example' },
];
if (process.argv.includes('--saml')) {
  const idpPort = Number(process.env.IDP_PORT ?? 3202);
  const idp = new MockSamlIdp({ entityId: `http://localhost:${idpPort}/saml`, ssoUrl: `http://localhost:${idpPort}/sso`, people: seedPeople() });
  idp.listen(idpPort);
  Object.assign(process.env, {
    SAML_IDP_SSO_URL: idp.ssoUrl,
    SAML_IDP_ENTITY_ID: idp.entityId,
    SAML_IDP_CERT: idp.certPem,
    SAML_ACS_URL: `http://localhost:${port}/auth/saml/acs`,
    HOST: process.env.HOST ?? '127.0.0.1',
  });
  console.log(`Mock SAML identity provider on ${idp.ssoUrl} (development only)`);
}
if (process.argv.includes('--sso')) {
  const idpPort = Number(process.env.IDP_PORT ?? 3201);
  const users = seedPeople();
  const issuer = `http://localhost:${idpPort}`;
  new MockIdp({ issuer, clientId: 'plan-ops-demo', people: users }).listen(idpPort);
  Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'plan-ops-demo', OIDC_REDIRECT_URI: `http://localhost:${port}/auth/callback`, HOST: process.env.HOST ?? '127.0.0.1' });
  console.log(`Mock identity provider on ${issuer} (development only)`);
}

const live = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
const clock = new DemoClock(new Date(Date.now() - 24 * 86_400_000));
const app = createApp({ dbPath: ':memory:', seedUsers: true, clock, aiModel: sampleModel, agentModel: sampleAgentModel });

// History and pre-generated panels always use the sample model, so seeding is free and offline.
const { cases } = await seedDemo(app, clock);
if (live) {
  app.ai.setModel(claudeModelCall());
  app.agents.setModel(claudeAgentModel());
}

console.log(`Demo data loaded: ${cases} cases. Claude: ${live ? 'live' : 'sample responses (set ANTHROPIC_API_KEY for live calls)'}`);
startServer(app, port, join(import.meta.dirname, '..', 'public'));

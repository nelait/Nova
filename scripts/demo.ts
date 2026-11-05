// `npm run demo`: an in-memory instance loaded with sample data.
// With ANTHROPIC_API_KEY set, "Ask Claude" calls Claude; otherwise it returns
// canned responses labeled as sample data.
// `npm run demo:sso` also starts a mock identity provider so you can try single
// sign-on end to end (pick who to sign in as on the provider's page).
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { claudeModelCall } from '../src/ai/claudeAssist.ts';
import { claudeAgentModel } from '../src/ai/agents.ts';
import { MockIdp } from '../src/auth/mockIdp.ts';
import { DemoClock, sampleAgentModel, sampleModel, seedDemo } from './demo-data.ts';

const port = Number(process.env.PORT ?? 3000);
if (process.argv.includes('--sso')) {
  const idpPort = Number(process.env.IDP_PORT ?? 3201);
  const users = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(import.meta.dirname, '..', 'config', 'users.json'), 'utf8'))) as { name: string; email: string }[];
  const issuer = `http://localhost:${idpPort}`;
  new MockIdp({ issuer, clientId: 'plan-ops-demo', people: [...users, { name: 'Someone not yet provisioned', email: 'new.hire@planops.example' }] }).listen(idpPort);
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

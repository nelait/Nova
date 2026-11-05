// `npm run demo`: an in-memory instance loaded with sample data.
// With ANTHROPIC_API_KEY set, "Ask Claude" calls Claude; otherwise it returns
// canned responses labeled as sample data.
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';
import { claudeModelCall } from '../src/ai/claudeAssist.ts';
import { DemoClock, sampleModel, seedDemo } from './demo-data.ts';

const live = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
const clock = new DemoClock(new Date(Date.now() - 24 * 86_400_000));
const app = createApp({ dbPath: ':memory:', seedUsers: true, clock, aiModel: sampleModel });

// History and pre-generated panels always use the sample model, so seeding is free and offline.
const { cases } = await seedDemo(app, clock);
if (live) app.ai.setModel(claudeModelCall());

console.log(`Demo data loaded: ${cases} cases. Claude: ${live ? 'live' : 'sample responses (set ANTHROPIC_API_KEY for live calls)'}`);
startServer(app, Number(process.env.PORT ?? 3000), join(import.meta.dirname, '..', 'public'));

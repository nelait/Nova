import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEvent, Case, OutboundEmail, Plan, Task, User } from './domain/types.ts';
import { systemClock, type Clock } from './domain/util.ts';
import { Collection, openDb } from './store/db.ts';
import { KnowledgeBase } from './knowledge/knowledgeBase.ts';
import { MockTracAdapter } from './integrations/recordkeeper.ts';
import { OutboxEmailGateway } from './integrations/email.ts';
import { ActionExecutor } from './actions/executor.ts';
import { UserDirectory } from './users/userDirectory.ts';
import { CaseService } from './cases/caseService.ts';
import { GuidanceService } from './guidance/guidedActions.ts';
import { computeInsights } from './learning/insights.ts';
import { AiAssistService, claudeModelCall, type AiAssist, type ModelCall } from './ai/claudeAssist.ts';

export interface AppOptions {
  dbPath?: string; // ':memory:' for tests
  configDir?: string;
  clock?: Clock;
  seedUsers?: boolean;
  /**
   * Model transport for AI assistance. Default: Claude when Anthropic credentials are
   * in the environment, otherwise disabled. Pass `null` to force-disable.
   */
  aiModel?: ModelCall | null;
}

function hasAnthropicCredentials(): boolean {
  if (process.env.AI_ASSIST === 'off') return false;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

/** Composition root: wires stores, integrations and services together. */
export function createApp(opts: AppOptions = {}) {
  const configDir = opts.configDir ?? join(import.meta.dirname, '..', 'config');
  const clock = opts.clock ?? systemClock;
  const db = openDb(opts.dbPath ?? ':memory:');

  const repos = {
    plans: new Collection<Plan>(db, 'plans'),
    cases: new Collection<Case>(db, 'cases'),
    tasks: new Collection<Task>(db, 'tasks'),
    audit: new Collection<AuditEvent>(db, 'audit'),
  };
  const usersRepo = new Collection<User>(db, 'users');
  const outbox = new Collection<OutboundEmail>(db, 'outbox');

  const kb = new KnowledgeBase(configDir);
  const trac = new MockTracAdapter(db, clock);
  const email = new OutboxEmailGateway(outbox);
  const executor = new ActionExecutor(kb, trac, email);
  const users = new UserDirectory(usersRepo);
  const cases = new CaseService(repos, kb, executor, trac, users, clock);
  const guidance = new GuidanceService(kb, executor);
  const aiModel = opts.aiModel === undefined ? (hasAnthropicCredentials() ? claudeModelCall() : undefined) : (opts.aiModel ?? undefined);
  const ai = new AiAssistService(cases, guidance, new Collection<AiAssist>(db, 'ai_assists'), clock, aiModel);
  cases.setAiDraftLookup((taskId) => ai.draftFor(taskId));

  if (opts.seedUsers && users.list().length === 0) {
    users.import(JSON.parse(readFileSync(join(configDir, 'users.json'), 'utf8')), 'seed');
  }

  return {
    clock,
    repos,
    kb,
    trac,
    email,
    users,
    cases,
    guidance,
    ai,
    insights: () => computeInsights(repos.cases.all(), repos.tasks.all(), users.list(), clock.now()),
  };
}

export type App = ReturnType<typeof createApp>;

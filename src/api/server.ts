import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createApp, type App } from '../app.ts';
import { NotFoundError, ValidationError } from '../store/db.ts';
import { ActionError } from '../actions/executor.ts';
import Anthropic from '@anthropic-ai/sdk';
import { AiError } from '../ai/claudeAssist.ts';
import { FUNCTIONS, RuleError } from '../rules/expression.ts';
import { IntegrationError } from '../integrations/client.ts';

type Handler = (ctx: { app: App; params: Record<string, string>; body: any; query: URLSearchParams; actor: string }) => unknown;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

// --- reference data
route('GET', '/api/playbooks', ({ app }) => app.kb.listPlaybooks());
route('GET', '/api/clients', ({ app }) => app.kb.listClients());

// --- users & skills (IdP import)
route('GET', '/api/users', ({ app }) => {
  const load = app.cases.openLoad();
  return app.users.list().map((u) => ({ ...u, openTasks: load.get(u.id) ?? 0 }));
});
route('POST', '/api/users/import', ({ app, body }) => app.users.import(body.users, body.source ?? 'api', !!body.fullSync));
route('POST', '/api/users/import/scim', ({ app, body }) => {
  const out = app.users.importScim(body.Resources ?? body.users, body.source ?? 'scim', !!body.fullSync);
  app.cases.routeUnassigned();
  return out;
});
route('POST', '/api/users/:id/active', ({ app, params, body }) => {
  const u = app.users.setActive(params.id, !!body.active);
  app.cases.routeUnassigned();
  return u;
});

// --- intake (all channels)
route('POST', '/api/intake', ({ app, body, actor }) => app.cases.submitIntake(body, actor));

// --- plans
route('GET', '/api/plans', ({ app }) => app.repos.plans.all().reverse());
route('GET', '/api/plans/:id', ({ app, params }) => app.repos.plans.require(params.id));
route('PATCH', '/api/plans/:id', ({ app, params, body, actor }) => app.cases.updatePlanDetails(params.id, body, actor));

// --- cases
route('GET', '/api/cases', ({ app }) =>
  app.repos.cases.all().reverse().map((c) => {
    const tasks = app.cases.tasksFor(c.id);
    const plan = app.repos.plans.get(c.planId);
    return { ...c, sponsorName: plan?.details.sponsorName, progress: { done: tasks.filter((t) => t.status === 'DONE' || t.status === 'SKIPPED').length, total: tasks.length } };
  }),
);
route('GET', '/api/cases/:id', ({ app, params }) => {
  const c = app.repos.cases.require(params.id);
  return { case: c, plan: app.repos.plans.require(c.planId), tasks: app.cases.tasksFor(c.id), audit: app.repos.audit.find((e) => e.caseId === c.id) };
});
route('POST', '/api/cases/:id/cancel', ({ app, params, body, actor }) => app.cases.cancelCase(params.id, actor, body.reason ?? ''));

// --- work items
route('GET', '/api/inbox/:userId', ({ app, params }) =>
  app.cases.inbox(params.userId).map((t) => {
    const c = app.repos.cases.require(t.caseId);
    return { ...t, caseType: c.type, sponsorName: app.repos.plans.require(t.planId).details.sponsorName };
  }),
);
route('GET', '/api/queue/unassigned', ({ app }) => app.cases.unassignedQueue());
route('GET', '/api/tasks/:id/guidance', ({ app, params, actor }) => app.guidance.forTask(app.cases.contextFor(app.repos.tasks.require(params.id), actor)));
route('POST', '/api/tasks/:id/start', ({ app, params, actor }) => app.cases.startTask(params.id, actor));
route('POST', '/api/tasks/:id/complete', ({ app, params, body, actor }) => app.cases.completeTask(params.id, actor, body));
// --- rules
route('GET', '/api/rules', ({ app }) =>
  app.kb.rules.list().map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    description: r.description ?? '',
    counts: { decisions: r.decisions?.length ?? 0, outputs: r.outputs?.length ?? 0, rules: r.rules?.length ?? 0, tests: r.tests?.length ?? 0 },
    usedBy: app.kb.listPlaybooks().flatMap((p) => p.steps.filter((s) => s.action.type === 'rules.evaluate' && s.action.params?.ruleSet === r.id).map((s) => `${p.caseType} / ${s.id}`)),
    overriddenBy: app.kb.listClients().filter((c) => Object.values(c.ruleSetOverrides ?? {}).includes(r.id)).map((c) => c.clientId),
  })),
);
route('GET', '/api/rules/functions', () => Object.entries(FUNCTIONS).map(([name, f]) => ({ name, doc: f.doc })));
route('GET', '/api/rules/:id', ({ app, params }) => app.kb.rules.get(params.id));
route('POST', '/api/rules/:id/test', ({ app, params }) => app.kb.rules.test(params.id));
route('POST', '/api/rules/:id/evaluate', ({ app, params, body }) => {
  // Evaluate against a live case (read-only) or a context supplied by the caller.
  const context = body.caseId ? app.cases.ruleContextForCase(String(body.caseId)) : (body.context ?? {});
  return { context, result: app.kb.rules.evaluate(params.id, context) };
});

route('GET', '/api/ai/status', ({ app }) => ({ enabled: app.ai.enabled, model: app.ai.model }));
route('GET', '/api/tasks/:id/ai-assist', ({ app, params, actor }) => app.ai.cached(params.id, actor));
route('POST', '/api/tasks/:id/ai-assist', ({ app, params, body, actor }) => app.ai.assist(params.id, actor, !!body.refresh));
route('POST', '/api/tasks/:id/reassign', ({ app, params, body, actor }) => app.cases.reassign(params.id, actor, body.toUserId));

// --- integrations & learning
// The Recordkeeper screen reads TRAC through its configured integration, like the engine does.
route('GET', '/api/trac/plans', async ({ app, actor }) => (await app.integrations.call('trac', 'listPlans', { actor })).data);
route('POST', '/api/trac/simulate-outage', ({ app, body }) => (app.trac.failNext(Number(body.requests ?? 10)), { armed: true }));

// --- integrations (configured external systems)
route('GET', '/api/integrations', ({ app }) =>
  app.kb.integrations.list().map((s) => ({
    id: s.def.id,
    name: s.def.name,
    description: s.def.description ?? '',
    baseUrl: s.baseUrl,
    mock: s.baseUrl.startsWith('mock://'),
    auth: s.def.auth?.type ?? 'none',
    secrets: app.integrations.secretStatus(s),
    timeoutMs: s.def.timeoutMs ?? 10000,
    retry: { attempts: s.def.retry?.attempts ?? 3, backoffMs: s.def.retry?.backoffMs ?? 250 },
    healthCheck: s.def.healthCheck ?? null,
    operations: [...s.operations.values()].map((o) => ({
      name: o.name,
      method: o.def.method,
      path: o.def.path,
      description: o.def.description ?? '',
      idempotent: o.def.method === 'GET' || !!o.def.idempotent,
      usedBy: app.kb.listPlaybooks().flatMap((p) =>
        p.steps.filter((st) => st.action.type === 'integration.call' && st.action.params?.system === s.def.id && st.action.params?.operation === o.name).map((st) => `${p.caseType} / ${st.id}`),
      ),
    })),
  })),
);
route('POST', '/api/integrations/:id/test', ({ app, params }) => app.integrations.test(params.id));
route('GET', '/api/integrations/calls', ({ app, query }) => app.integrations.calls(Number(query.get('limit') ?? 50)));
route('GET', '/api/outbox', ({ app }) => app.email.list());
route('GET', '/api/insights', ({ app }) => app.insights());
route('GET', '/api/audit', ({ app, query }) => app.repos.audit.all().reverse().slice(0, Number(query.get('limit') ?? 200)));

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startServer(app: App, port: number, publicDir: string) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          const m = req.method === r.method && url.pathname.match(r.pattern);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          // Prototype auth: the acting user comes from a header. Replace with OIDC/SAML session.
          const actor = String(req.headers['x-user-id'] ?? 'anonymous');
          const body = req.method === 'GET' ? {} : await readBody(req);
          return send(res, 200, await r.handler({ app, params, body, query: url.searchParams, actor }));
        }
        return send(res, 404, { error: 'No such route' });
      }
      const file = normalize(join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(publicDir)) return send(res, 403, { error: 'Forbidden' });
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e instanceof NotFoundError || (e as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, { error: (e as Error).message });
      if (e instanceof ValidationError || e instanceof ActionError || e instanceof SyntaxError || e instanceof RuleError) {
        return send(res, 422, { error: (e as Error).message, issues: (e as ValidationError).issues ?? [] });
      }
      if (e instanceof AiError) return send(res, 503, { error: e.message });
      if (e instanceof IntegrationError) return send(res, 502, { error: e.message });
      if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Claude is rate limited; try again shortly' });
      if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: 'Claude rejected the API credentials' });
      if (e instanceof Anthropic.APIConnectionError) return send(res, 503, { error: 'Could not reach Claude' });
      if (e instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API error ${e.status}` });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  });
  server.listen(port, () => console.log(`Plan Ops Hub on http://localhost:${port}`));
  return server;
}


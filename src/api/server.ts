import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createApp, type App } from '../app.ts';
import { NotFoundError, ValidationError } from '../store/db.ts';
import { ActionError } from '../actions/executor.ts';

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
route('POST', '/api/tasks/:id/reassign', ({ app, params, body, actor }) => app.cases.reassign(params.id, actor, body.toUserId));

// --- integrations & learning
route('GET', '/api/trac/plans', ({ app }) => app.trac.listPlans());
route('POST', '/api/trac/simulate-outage', ({ app, body }) => ((app.trac.failNextWith = body.message ?? 'simulated outage'), { armed: true }));
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
      if (e instanceof ValidationError || e instanceof ActionError || e instanceof SyntaxError) {
        return send(res, 422, { error: (e as Error).message, issues: (e as ValidationError).issues ?? [] });
      }
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  });
  server.listen(port, () => console.log(`Plan Ops Hub on http://localhost:${port}`));
  return server;
}


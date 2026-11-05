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
import { AgentError } from '../ai/agents.ts';
import { AuthError } from '../auth/oidc.ts';
import type { AuditEvent, User } from '../domain/types.ts';
import { isAdmin as hasAdmin, isAuditor } from '../users/roles.ts';

type Handler = (ctx: { app: App; params: Record<string, string>; body: any; query: URLSearchParams; actor: string; me?: User; isAdmin: boolean }) => unknown;

/**
 * Routes marked `admin` need the admin role (identity-provider group role:admin).
 * Auditors (role:auditor) may only use GET routes and POST routes marked
 * `readOnly`, which compute an answer without changing anything.
 */
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; admin: boolean; readOnly: boolean }[] = [];
function route(method: string, path: string, handler: Handler, opts: { admin?: boolean; readOnly?: boolean } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler, admin: !!opts.admin, readOnly: method === 'GET' || !!opts.readOnly });
}

class ForbiddenError extends Error {}

// --- who am I
route('GET', '/api/me', ({ app, me }) => ({
  mode: app.auth.mode,
  user: me ? { id: me.id, name: me.name, email: me.email, roles: me.roles ?? [], skills: me.skills, readOnly: isAuditor(me), admin: hasAdmin(me) } : null,
}));

// --- reference data
route('GET', '/api/playbooks', ({ app }) => app.kb.listPlaybooks());
route('GET', '/api/clients', ({ app }) => app.kb.listClients());

// --- users & skills (IdP import)
route('GET', '/api/users', ({ app }) => {
  const load = app.cases.openLoad();
  return app.users.list().map((u) => ({ ...u, openTasks: load.get(u.id) ?? 0 }));
});
route('POST', '/api/users/import', ({ app, body }) => app.users.import(body.users, body.source ?? 'api', !!body.fullSync), { admin: true });
route('POST', '/api/users/import/scim', ({ app, body }) => {
  const out = app.users.importScim(body.Resources ?? body.users, body.source ?? 'scim', !!body.fullSync);
  app.cases.routeUnassigned();
  return out;
}, { admin: true });
route('POST', '/api/users/:id/active', ({ app, params, body }) => {
  const u = app.users.setActive(params.id, !!body.active);
  app.cases.routeUnassigned();
  return u;
}, { admin: true });

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
route('POST', '/api/cases/:id/cancel', ({ app, params, body, actor }) => app.cases.cancelCase(params.id, actor, body.reason ?? ''), { admin: true });

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
route('POST', '/api/rules/:id/test', ({ app, params }) => app.kb.rules.test(params.id), { readOnly: true });
route('POST', '/api/rules/:id/evaluate', ({ app, params, body }) => {
  // Evaluate against a live case (read-only) or a context supplied by the caller.
  const context = body.caseId ? app.cases.ruleContextForCase(String(body.caseId)) : (body.context ?? {});
  return { context, result: app.kb.rules.evaluate(params.id, context) };
}, { readOnly: true });

route('GET', '/api/ai/status', ({ app }) => ({ enabled: app.ai.enabled, model: app.ai.model }));
route('GET', '/api/tasks/:id/ai-assist', ({ app, params, actor }) => app.ai.cached(params.id, actor));
route('POST', '/api/tasks/:id/ai-assist', ({ app, params, body, actor }) => app.ai.assist(params.id, actor, !!body.refresh));
route('POST', '/api/tasks/:id/agent/run', ({ app, params, actor }) => app.cases.rerunAgent(params.id, actor));
route('GET', '/api/agents', ({ app }) =>
  app.kb.agents.list().map((a) => ({
    ...a,
    enabled: app.agents.enabled,
    usedBy: app.kb.listPlaybooks().flatMap((p) => p.steps.filter((s) => s.action.type === 'ai.agent' && s.action.params?.agent === a.id).map((s) => `${p.caseType} / ${s.id}`)),
  })),
);
route('POST', '/api/tasks/:id/reassign', ({ app, params, body, actor, isAdmin }) => {
  // The task's owner can hand it back to routing; moving anyone else's task needs admin.
  if (!isAdmin && app.repos.tasks.require(params.id).assigneeId !== actor) throw new ForbiddenError('Only the task owner or an admin can reassign this task');
  return app.cases.reassign(params.id, actor, body.toUserId);
});

// --- integrations & learning
// The Recordkeeper screen reads TRAC through its configured integration, like the engine does.
route('GET', '/api/trac/plans', async ({ app, actor }) => (await app.integrations.call('trac', 'listPlans', { actor })).data);
// Demo aid for the built-in mock TRAC only; never available with single sign-on.
route('POST', '/api/trac/simulate-outage', ({ app, body }) => {
  if (app.auth.mode !== 'dev') throw new NotFoundError('No such route');
  app.trac.failNext(Number(body.requests ?? 10));
  return { armed: true };
}, { admin: true });

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
route('POST', '/api/integrations/:id/test', ({ app, params }) => app.integrations.test(params.id), { admin: true });
route('GET', '/api/integrations/calls', ({ app, query }) => app.integrations.calls(Number(query.get('limit') ?? 50)));
route('GET', '/api/outbox', ({ app }) => app.email.list());
route('GET', '/api/insights', ({ app }) => app.insights());
// Audit log, newest first, with optional filters. format=csv downloads it for review elsewhere.
route('GET', '/api/audit', ({ app, query }) => {
  const q = (k: string) => query.get(k)?.trim() || undefined;
  const [actor, event, entity, from, to] = [q('actor'), q('event'), q('entityId'), q('from'), q('to')];
  const rows = app.repos.audit
    .all()
    .reverse()
    .filter((e) => (!actor || e.actor === actor) && (!event || e.event.startsWith(event)) && (!entity || e.entityId === entity) && (!from || e.at >= from) && (!to || e.at < to));
  const limit = Math.min(Number(q('limit') ?? 200), 10_000);
  if (q('format') === 'csv') return new CsvBody(auditCsv(rows.slice(0, limit)));
  return rows.slice(0, limit);
});

/** A handler result sent as a CSV download instead of JSON. */
class CsvBody {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
function auditCsv(rows: AuditEvent[]): string {
  // Quote every cell; a leading = + - @ is prefixed with ' so spreadsheets don't run it as a formula.
  const cell = (v: unknown) => {
    let s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cols = ['at', 'actor', 'event', 'entity', 'entityId', 'caseId', 'detail'] as const;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(','))].join('\r\n') + '\r\n';
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const SESSION_COOKIE = 'planops_session';
const LOGIN_COOKIE = 'planops_login';

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Small themed HTML page for sign-in outcomes. */
function page(res: ServerResponse, status: number, title: string, message: string, action?: { href: string; label: string }) {
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Plan Ops Hub</title>
<link rel="stylesheet" href="/theme.css"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.55 var(--font-body);padding:24px}
main{max-width:30em;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}h1{font:600 24px/1.2 var(--font-display);margin:0 0 10px}
a{display:inline-block;margin-top:14px;background:var(--accent);color:var(--accent-ink);padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:700}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${action ? `<a href="${esc(action.href)}">${esc(action.label)}</a>` : ''}</main></body></html>`);
}

/** Requests that change data must be JSON from this app's own pages (blocks cross-site forms and scripts). */
function checkSameOrigin(req: IncomingMessage): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ForbiddenError('Requests that change data must be sent as application/json');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new ForbiddenError('Cross-site request refused');
}

async function handleAuth(app: App, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = app.auth;
  if (auth.mode !== 'oidc') return send(res, 404, { error: 'Single sign-on is not configured' });
  const secure = auth.secureCookies;
  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const { url: to, state } = await auth.startLogin(url.searchParams.get('returnTo'));
    res.writeHead(302, { location: to, 'set-cookie': cookie(LOGIN_COOKIE, state, 600, secure), 'cache-control': 'no-store' });
    return void res.end();
  }
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const idpError = url.searchParams.get('error');
    if (idpError) return page(res, 400, 'Sign-in was not completed', `The identity provider reported: ${url.searchParams.get('error_description') ?? idpError}.`, { href: '/auth/login', label: 'Try again' });
    try {
      const { token, returnTo } = await auth.finishLogin(url.searchParams.get('code'), url.searchParams.get('state'), cookies(req)[LOGIN_COOKIE]);
      res.writeHead(302, {
        location: returnTo,
        'set-cookie': [cookie(SESSION_COOKIE, token, auth.sessionSeconds, secure), cookie(LOGIN_COOKIE, '', 0, secure)],
        'cache-control': 'no-store',
      });
      return void res.end();
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      res.setHeader('set-cookie', cookie(LOGIN_COOKIE, '', 0, secure));
      return page(res, e.status === 403 ? 403 : 400, e.status === 403 ? 'You don’t have access yet' : 'Sign-in failed', e.message, e.status === 403 ? undefined : { href: '/auth/login', label: 'Sign in again' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    checkSameOrigin(req);
    auth.logout(cookies(req)[SESSION_COOKIE]);
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', 0, secure));
    return send(res, 200, { redirect: '/auth/signed-out' });
  }
  if (req.method === 'GET' && url.pathname === '/auth/signed-out') {
    return page(res, 200, 'You’re signed out', 'Your Plan Ops Hub session has ended. You may still be signed in to your organization’s identity provider.', { href: '/auth/login', label: 'Sign in again' });
  }
  return send(res, 404, { error: 'No such route' });
}

export function startServer(app: App, port: number, publicDir: string, opts: { host?: string } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (url.pathname.startsWith('/auth/')) return await handleAuth(app, req, res, url);
      if (url.pathname.startsWith('/api/')) {
        // Who is calling: the signed-in user with single sign-on; in development
        // mode (localhost only) the user picked in the UI, sent as x-user-id.
        let me: User | undefined;
        let actor: string;
        if (app.auth.mode === 'oidc') {
          me = app.auth.userFor(cookies(req)[SESSION_COOKIE]);
          if (!me) return send(res, 401, { error: 'Sign in required', signIn: '/auth/login' });
          actor = me.id;
        } else {
          actor = String(req.headers['x-user-id'] ?? 'anonymous');
          me = app.users.get(actor);
        }
        checkSameOrigin(req);
        for (const r of routes) {
          const m = req.method === r.method && url.pathname.match(r.pattern);
          if (!m) continue;
          const isAdmin = hasAdmin(me);
          if (!r.readOnly && isAuditor(me)) throw new ForbiddenError('Auditors have read-only access');
          if (r.admin && !isAdmin) throw new ForbiddenError('This action needs the admin role');
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = req.method === 'GET' ? {} : await readBody(req);
          const result = await r.handler({ app, params, body, query: url.searchParams, actor, me, isAdmin });
          if (result instanceof CsvBody) {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="plan-ops-audit.csv"', 'cache-control': 'no-store' });
            return void res.end(result.text);
          }
          return send(res, 200, result);
        }
        return send(res, 404, { error: 'No such route' });
      }
      // The product site and docs (built by npm run site:build) are served under /site/.
      const isSite = url.pathname === '/site' || url.pathname.startsWith('/site/');
      if (url.pathname === '/site') {
        res.writeHead(301, { location: '/site/' });
        return res.end();
      }
      const baseDir = isSite ? join(publicDir, '..', 'site') : publicDir;
      let rel = isSite ? url.pathname.slice('/site'.length) : url.pathname;
      if (rel === '/' || rel === '') rel = '/index.html';
      else if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(baseDir, decodeURIComponent(rel)));
      if (!file.startsWith(normalize(baseDir))) return send(res, 403, { error: 'Forbidden' });
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e instanceof ForbiddenError) return send(res, 403, { error: e.message });
      if (e instanceof AuthError) return send(res, e.status, { error: e.message });
      if (e instanceof NotFoundError || (e as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, { error: (e as Error).message });
      if (e instanceof ValidationError || e instanceof ActionError || e instanceof SyntaxError || e instanceof RuleError) {
        return send(res, 422, { error: (e as Error).message, issues: (e as ValidationError).issues ?? [] });
      }
      if (e instanceof AiError) return send(res, 503, { error: e.message });
      if (e instanceof IntegrationError) return send(res, 502, { error: e.message });
      if (e instanceof AgentError) return send(res, 503, { error: e.message });
      if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Claude is rate limited; try again shortly' });
      if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: 'Claude rejected the API credentials' });
      if (e instanceof Anthropic.APIConnectionError) return send(res, 503, { error: 'Could not reach Claude' });
      if (e instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API error ${e.status}` });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  });
  // Without single sign-on anyone could act as anyone, so development mode only
  // listens on this computer. Configure OIDC_* to serve on a network.
  const host = opts.host ?? process.env.HOST ?? (app.auth.mode === 'dev' ? '127.0.0.1' : '0.0.0.0');
  if (app.auth.mode === 'dev' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Development mode (no sign-in) only listens on localhost, not ${host}. Configure single sign-on (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI) to serve on a network.`);
  }
  server.listen(port, host, () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Plan Ops Hub on http://${host === '0.0.0.0' ? 'localhost' : host}:${p} (${app.auth.mode === 'oidc' ? 'single sign-on' : 'development mode: no sign-in, localhost only'})`);
  });
  return server;
}


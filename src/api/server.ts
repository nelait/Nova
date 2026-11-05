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
import type { AuditEvent, Plan, User } from '../domain/types.ts';
import { PERMISSIONS, type Permission } from '../users/roles.ts';

type Handler = (ctx: { app: App; params: Record<string, string>; body: any; query: URLSearchParams; actor: string; me?: User; can: (p: Permission) => boolean; scope: ClientScope }) => unknown;

/**
 * Which plans and cases the caller may see and act on: their clients
 * (clients.all, or client:<id> groups), then each plan's allow and deny lists
 * (plans.unrestricted sees past those). Anything else is reported as not found
 * rather than forbidden, so its existence isn't revealed.
 */
type ClientScope = ReturnType<typeof clientScope>;

/**
 * Who is on a plan's allow and deny lists is shown only to people who manage
 * access: a deny list can reveal someone's conflict of interest. Others see only
 * that the plan is restricted.
 */
function showPlan(plan: Plan, canManage: boolean): Plan | (Omit<Plan, 'access'> & { access?: { restricted: true } }) {
  if (!plan.access || canManage) return plan;
  return { ...plan, access: { restricted: true } };
}
function clientScope(app: App, me: User | undefined) {
  /** Sees every plan of every client. */
  const all = app.users.can(me, 'clients.all') && app.users.can(me, 'plans.unrestricted');
  const ok = (clientId: string | undefined) => !!clientId && app.users.canAccessClient(me, clientId);
  const plan = (p: Plan | undefined) => !!p && (all || app.users.canAccessPlan(me, p));
  const planOk = (planId: string | undefined) => all || (!!planId && plan(app.repos.plans.get(planId)));
  const caseOk = (caseId: string | undefined) => all || (!!caseId && planOk(app.repos.cases.get(caseId)?.planId));
  const hidden = (what: string, id: string) => new NotFoundError(`${what}/${id} not found`);
  return {
    all,
    ok,
    plan,
    caseOk,
    planOk,
    requireCase(id: string) {
      const c = app.repos.cases.require(id);
      if (!planOk(c.planId)) throw hidden('cases', id);
      return c;
    },
    requirePlan(id: string) {
      const p = app.repos.plans.require(id);
      if (!plan(p)) throw hidden('plans', id);
      return p;
    },
    requireTask(id: string) {
      const t = app.repos.tasks.require(id);
      if (!caseOk(t.caseId)) throw hidden('tasks', id);
      return t;
    },
  };
}

/**
 * Every route that changes something names the permission it needs (see
 * config/roles.json). Routes that only read need none, unless they name one;
 * `readOnly` marks a POST that only computes an answer (rule tests).
 * Registering a changing route without a permission is a startup error.
 */
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; perm?: Permission[]; readOnly: boolean }[] = [];
/** `perm`: the permission needed; a list means any one of them. */
function route(method: string, path: string, handler: Handler, opts: { perm?: Permission | Permission[]; readOnly?: boolean } = {}) {
  const readOnly = method === 'GET' || !!opts.readOnly;
  if (!readOnly && !opts.perm) throw new Error(`${method} ${path} changes data but names no permission`);
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler, perm: opts.perm === undefined ? undefined : [opts.perm].flat(), readOnly });
}

class ForbiddenError extends Error {}

// --- who am I
route('GET', '/api/me', ({ app, me }) => ({
  mode: app.auth.mode,
  user: me
    ? {
        id: me.id,
        name: me.name,
        email: me.email,
        roles: app.users.roles.rolesOf(me),
        permissions: app.users.roles.permissions(me),
        readOnly: app.users.roles.isReadOnly(me),
        skills: me.skills,
      }
    : null,
}));

// --- roles and permissions, for the Team screen and administrators
route('GET', '/api/roles', ({ app }) => ({ permissions: PERMISSIONS, ...app.users.roles.config }));

// --- reference data
route('GET', '/api/playbooks', ({ app }) => app.kb.listPlaybooks());
route('GET', '/api/clients', ({ app, scope }) => app.kb.listClients().filter((c) => scope.ok(c.clientId)));

// --- users & skills (IdP import)
route('GET', '/api/users', ({ app }) => {
  const load = app.cases.openLoad();
  return app.users.list().map((u) => ({ ...u, allClients: app.users.can(u, 'clients.all'), openTasks: load.get(u.id) ?? 0 }));
});
route('POST', '/api/users/import', ({ app, body }) => app.users.import(body.users, body.source ?? 'api', !!body.fullSync), { perm: 'users.manage' });
route('POST', '/api/users/import/scim', ({ app, body }) => {
  const out = app.users.importScim(body.Resources ?? body.users, body.source ?? 'scim', !!body.fullSync);
  app.cases.routeUnassigned();
  return out;
}, { perm: 'users.manage' });
route('POST', '/api/users/:id/active', ({ app, params, body }) => {
  const u = app.users.setActive(params.id, !!body.active);
  app.cases.routeUnassigned();
  return u;
}, { perm: 'users.manage' });

// --- intake (all channels)
route('POST', '/api/intake', ({ app, body, actor, scope }) => {
  // A change to an existing plan is for that plan's client; a new plan names its client.
  if (body.planId) scope.requirePlan(String(body.planId));
  else if (!scope.ok(body.clientId || 'default')) throw new ForbiddenError(`You don't have access to client ${body.clientId || 'default'}`);
  return app.cases.submitIntake(body, actor);
}, { perm: 'cases.start' });

// --- plans
route('GET', '/api/plans', ({ app, scope, can }) => app.repos.plans.all().reverse().filter(scope.plan).map((p) => showPlan(p, can('plans.restrict'))));
route('GET', '/api/plans/:id', ({ params, scope, can }) => showPlan(scope.requirePlan(params.id), can('plans.restrict')));
// Who may see and work a plan: { allow?: userIds, deny?: userIds, note }. Empty lists lift the restriction.
route('PUT', '/api/plans/:id/access', ({ app, params, body, actor, scope }) => (scope.requirePlan(params.id), app.cases.setPlanAccess(params.id, body ?? {}, actor)), { perm: 'plans.restrict' });
route('PATCH', '/api/plans/:id', ({ app, params, body, actor, scope }) => (scope.requirePlan(params.id), app.cases.updatePlanDetails(params.id, body, actor)), { perm: 'plans.edit' });

// --- cases
route('GET', '/api/cases', ({ app, scope }) =>
  app.repos.cases.all().reverse().filter((c) => scope.planOk(c.planId)).map((c) => {
    const tasks = app.cases.tasksFor(c.id);
    const plan = app.repos.plans.get(c.planId);
    return { ...c, sponsorName: plan?.details.sponsorName, restricted: !!plan?.access, progress: { done: tasks.filter((t) => t.status === 'DONE' || t.status === 'SKIPPED').length, total: tasks.length } };
  }),
);
route('GET', '/api/cases/:id', ({ app, params, scope, can }) => {
  const c = scope.requireCase(params.id);
  const plan = app.repos.plans.require(c.planId);
  // Who could be on the plan's lists: people with access to its client (for the access editor).
  const manage = can('plans.restrict');
  const users = manage ? app.users.list().filter((u) => u.active && app.users.canAccessClient(u, plan.clientId)).map((u) => ({ id: u.id, name: u.name })) : undefined;
  return { case: c, plan: showPlan(plan, manage), users, tasks: app.cases.tasksFor(c.id), audit: app.repos.audit.find((e) => e.caseId === c.id) };
});
route('POST', '/api/cases/:id/cancel', ({ app, params, body, actor, scope }) => (scope.requireCase(params.id), app.cases.cancelCase(params.id, actor, body.reason ?? '')), { perm: 'cases.cancel' });

// --- work items
route('GET', '/api/inbox/:userId', ({ app, params, scope }) =>
  app.cases.inbox(params.userId).filter((t) => scope.caseOk(t.caseId)).map((t) => {
    const c = app.repos.cases.require(t.caseId);
    return { ...t, caseType: c.type, sponsorName: app.repos.plans.require(t.planId).details.sponsorName };
  }),
);
route('GET', '/api/queue/unassigned', ({ app, scope }) => app.cases.unassignedQueue().filter((t) => scope.caseOk(t.caseId)));
route('GET', '/api/tasks/:id/guidance', ({ app, params, actor, scope }) => app.guidance.forTask(app.cases.contextFor(scope.requireTask(params.id), actor)));
route('POST', '/api/tasks/:id/start', ({ app, params, actor, scope }) => (scope.requireTask(params.id), app.cases.startTask(params.id, actor)), { perm: 'tasks.work' });
route('POST', '/api/tasks/:id/complete', ({ app, params, body, actor, can, scope }) => {
  scope.requireTask(params.id);
  if (body.override && !can('tasks.override')) throw new ForbiddenError('Overriding a failed step needs the tasks.override permission');
  return app.cases.completeTask(params.id, actor, body);
}, { perm: 'tasks.work' });
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
route('POST', '/api/rules/:id/evaluate', ({ app, params, body, scope }) => {
  // Evaluate against a live case (read-only) or a context supplied by the caller.
  const context = body.caseId ? app.cases.ruleContextForCase(scope.requireCase(String(body.caseId)).id) : (body.context ?? {});
  return { context, result: app.kb.rules.evaluate(params.id, context) };
}, { readOnly: true });

route('GET', '/api/ai/status', ({ app }) => ({ enabled: app.ai.enabled, model: app.ai.model }));
route('GET', '/api/tasks/:id/ai-assist', ({ app, params, actor, scope }) => (scope.requireTask(params.id), app.ai.cached(params.id, actor)));
route('POST', '/api/tasks/:id/ai-assist', ({ app, params, body, actor, scope }) => (scope.requireTask(params.id), app.ai.assist(params.id, actor, !!body.refresh)), { perm: 'tasks.work' });
route('POST', '/api/tasks/:id/agent/run', ({ app, params, actor, scope }) => (scope.requireTask(params.id), app.cases.rerunAgent(params.id, actor)), { perm: 'tasks.work' });
route('GET', '/api/agents', ({ app }) =>
  app.kb.agents.list().map((a) => ({
    ...a,
    enabled: app.agents.enabled,
    usedBy: app.kb.listPlaybooks().flatMap((p) => p.steps.filter((s) => s.action.type === 'ai.agent' && s.action.params?.agent === a.id).map((s) => `${p.caseType} / ${s.id}`)),
  })),
);
route('POST', '/api/tasks/:id/reassign', ({ app, params, body, actor, can, scope }) => {
  scope.requireTask(params.id);
  // The task's owner can hand it back to routing; moving anyone else's task needs tasks.reassign.
  if (!can('tasks.reassign') && app.repos.tasks.require(params.id).assigneeId !== actor) throw new ForbiddenError("Reassigning someone else's task needs the tasks.reassign permission");
  return app.cases.reassign(params.id, actor, body.toUserId);
}, { perm: ['tasks.work', 'tasks.reassign'] });

// --- integrations & learning
// The Recordkeeper screen reads TRAC through its configured integration, like the engine does.
route('GET', '/api/trac/plans', async ({ app, actor, scope }) => {
  const plans = (await app.integrations.call('trac', 'listPlans', { actor })).data as { id: string }[];
  if (scope.all) return plans;
  // Only recordkeeper plans that belong to one of the caller's clients.
  const mine = new Set(app.repos.plans.find((p) => !!p.tracPlanId && scope.plan(p)).map((p) => p.tracPlanId));
  return plans.filter((p) => mine.has(p.id));
});
// Demo aid for the built-in mock TRAC only; never available with single sign-on.
route('POST', '/api/trac/simulate-outage', ({ app, body }) => {
  if (app.auth.mode !== 'dev') throw new NotFoundError('No such route');
  app.trac.failNext(Number(body.requests ?? 10));
  return { armed: true };
}, { perm: 'integrations.test' });

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
route('POST', '/api/integrations/:id/test', ({ app, params }) => app.integrations.test(params.id), { perm: 'integrations.test' });
// Calls not made for a case (connection tests, recordkeeper listings) are shown only with clients.all.
route('GET', '/api/integrations/calls', ({ app, query, scope }) => {
  const limit = Number(query.get('limit') ?? 50);
  return scope.all ? app.integrations.calls(limit) : app.integrations.calls(10_000).filter((c) => scope.caseOk(c.caseId)).slice(0, limit);
});
route('GET', '/api/outbox', ({ app, scope }) => app.email.list().filter((e) => scope.caseOk(e.caseId)));
route('GET', '/api/insights', ({ app, scope }) => app.insights(scope.all ? undefined : (c) => scope.planOk(c.planId)));
// Audit log, newest first, with optional filters. format=csv downloads it for review elsewhere.
route('GET', '/api/audit', ({ app, query, scope }) => {
  const q = (k: string) => query.get(k)?.trim() || undefined;
  const [actor, event, entity, from, to] = [q('actor'), q('event'), q('entityId'), q('from'), q('to')];
  const rows = app.repos.audit
    .all()
    .reverse()
    .filter((e) => (!actor || e.actor === actor) && (!event || e.event.startsWith(event)) && (!entity || e.entityId === entity) && (!from || e.at >= from) && (!to || e.at < to))
    // Restricted to some clients: their cases' and plans' events, plus events not about a client (sign-ins, user changes).
    .filter((e) => scope.all || (e.caseId ? scope.caseOk(e.caseId) : e.entity === 'plan' ? scope.planOk(e.entityId) : true));
  const limit = Math.min(Number(q('limit') ?? 200), 10_000);
  if (q('format') === 'csv') return new CsvBody(auditCsv(rows.slice(0, limit)));
  return rows.slice(0, limit);
}, { perm: 'audit.read' });

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
/** Holds a pending IdP-initiated SAML sign-in until the person confirms it (2 minutes). */
const IDP_SIGNIN_COOKIE = 'planops_idp_signin';

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean, sameSite: 'Lax' | 'None' = 'Lax'): string {
  // SameSite=None requires Secure; browsers accept Secure cookies on http://localhost.
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure || sameSite === 'None' ? '; Secure' : ''}`;
}

/** Reads an application/x-www-form-urlencoded body (the SAML POST binding), capped at 512 KB. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new AuthError('Expected a form post from the identity provider', 400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 512 * 1024) throw new AuthError('Sign-in response is too large', 413);
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Small themed HTML page for sign-in outcomes. */
function page(res: ServerResponse, status: number, title: string, message: string, action?: { href: string; label: string }, formsHtml = '', headers: Record<string, string | string[]> = {}) {
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Plan Ops Hub</title>
<link rel="stylesheet" href="/theme.css"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.55 var(--font-body);padding:24px}
main{max-width:30em;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}h1{font:600 24px/1.2 var(--font-display);margin:0 0 10px}
a,button{display:inline-block;margin-top:14px;background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);padding:9px 16px;border-radius:6px;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}
.forms{display:flex;gap:10px;flex-wrap:wrap}.forms form{margin:0}button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line)}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${formsHtml}${action ? `<a href="${esc(action.href)}">${esc(action.label)}</a>` : ''}</main></body></html>`);
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
  if (auth.mode === 'dev') return send(res, 404, { error: 'Single sign-on is not configured' });
  const secure = auth.secureCookies;
  const saml = auth.mode === 'saml';
  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const { url: to, state } = await auth.startLogin(url.searchParams.get('returnTo'));
    // SAML responses arrive as a cross-site POST, which only carries SameSite=None cookies.
    res.writeHead(302, { location: to, 'set-cookie': cookie(LOGIN_COOKIE, state, 600, secure, saml ? 'None' : 'Lax'), 'cache-control': 'no-store' });
    return void res.end();
  }
  if (saml && req.method === 'GET' && url.pathname === '/auth/saml/metadata') {
    res.writeHead(200, { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' });
    return void res.end(auth.saml!.metadata());
  }
  if (saml && req.method === 'POST' && url.pathname === '/auth/saml/acs') {
    try {
      const form = await readForm(req);
      const result = await auth.finishSamlLogin(form.get('SAMLResponse'), form.get('RelayState'), cookies(req)[LOGIN_COOKIE], cookies(req)[SESSION_COOKIE]);
      if (result.kind === 'confirm') {
        // IdP-initiated: no session until the person confirms, on this browser.
        const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        const who = `${result.user.name} (${result.user.email})`;
        return page(
          res,
          200,
          'Continue to Plan Ops Hub?',
          result.currentUser
            ? `You're signed in as ${result.currentUser.name}. Your identity provider is signing you in as ${who}. Switch to that account?`
            : `Your identity provider is signing you in as ${who}. If that isn't you, cancel.`,
          undefined,
          `<div class="forms"><form method="post" action="/auth/saml/continue"><button type="submit" autofocus>Continue as ${esc(result.user.name)}</button></form>` +
            `<form method="post" action="/auth/saml/cancel"><button type="submit" class="secondary">Cancel</button></form></div>`,
          { 'set-cookie': [cookie(IDP_SIGNIN_COOKIE, result.token, 120, secure), cookie(LOGIN_COOKIE, '', 0, secure, 'None')] },
        );
      }
      // 303: follow with a GET. The session cookie is Lax; the redirect is a top-level navigation, so it is sent.
      res.writeHead(303, {
        location: result.returnTo,
        'set-cookie': result.kind === 'session' ? [cookie(SESSION_COOKIE, result.token, auth.sessionSeconds, secure), cookie(LOGIN_COOKIE, '', 0, secure, 'None')] : cookie(LOGIN_COOKIE, '', 0, secure, 'None'),
        'cache-control': 'no-store',
      });
      return void res.end();
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      res.setHeader('set-cookie', cookie(LOGIN_COOKIE, '', 0, secure, 'None'));
      return page(res, e.status === 403 ? 403 : 400, e.status === 403 ? 'You don’t have access yet' : 'Sign-in failed', e.message, e.status === 403 ? undefined : { href: '/auth/login', label: 'Sign in again' });
    }
  }
  // Confirming or cancelling an IdP-initiated sign-in: only from this site's own page,
  // on the browser holding the cookie that page set.
  if (saml && req.method === 'POST' && (url.pathname === '/auth/saml/continue' || url.pathname === '/auth/saml/cancel')) {
    const origin = req.headers.origin;
    if (!origin || new URL(origin).host !== req.headers.host) return page(res, 403, 'Sign-in refused', 'This confirmation must come from the Plan Ops Hub page that asked for it.');
    const pending = cookies(req)[IDP_SIGNIN_COOKIE];
    if (url.pathname === '/auth/saml/cancel') {
      auth.cancelIdpSignIn(pending);
      return page(res, 200, 'Sign-in cancelled', 'You were not signed in to Plan Ops Hub.', { href: '/auth/login', label: 'Sign in' }, '', { 'set-cookie': cookie(IDP_SIGNIN_COOKIE, '', 0, secure) });
    }
    try {
      const { token, returnTo } = auth.confirmIdpSignIn(pending);
      res.writeHead(303, { location: returnTo, 'set-cookie': [cookie(SESSION_COOKIE, token, auth.sessionSeconds, secure), cookie(IDP_SIGNIN_COOKIE, '', 0, secure)], 'cache-control': 'no-store' });
      return void res.end();
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      return page(res, e.status === 403 ? 403 : 400, e.status === 403 ? 'You don’t have access yet' : 'Sign-in failed', e.message, undefined, '', { 'set-cookie': cookie(IDP_SIGNIN_COOKIE, '', 0, secure) });
    }
  }
  if (!saml && req.method === 'GET' && url.pathname === '/auth/callback') {
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
    // Ends the local session, then (single logout) sends the browser to the provider.
    const redirect = await auth.logout(cookies(req)[SESSION_COOKIE]);
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', 0, secure));
    return send(res, 200, { redirect });
  }
  // OIDC back-channel logout: the provider calls this server to server, so no cookie or Origin.
  if (!saml && req.method === 'POST' && url.pathname === '/auth/oidc/backchannel-logout') {
    try {
      const ended = await auth.backchannelLogout((await readForm(req)).get('logout_token'));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ ended }));
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      return send(res, e.status === 404 ? 404 : 400, { error: 'invalid_request', error_description: e.message });
    }
  }
  // SAML single logout: LogoutRequests from the provider and LogoutResponses to ours, via the browser.
  if (saml && (req.method === 'GET' || req.method === 'POST') && url.pathname === '/auth/saml/slo') {
    try {
      const params = req.method === 'GET' ? url.searchParams : await readForm(req);
      const { redirect, confirmed } = await auth.samlSlo(req.method, params, url.search.slice(1));
      res.writeHead(req.method === 'GET' ? 302 : 303, {
        location: confirmed ? redirect : '/auth/signed-out?unconfirmed=1',
        // If this browser is the one being signed out, drop its cookie too.
        'set-cookie': cookie(SESSION_COOKIE, '', 0, secure),
        'cache-control': 'no-store',
      });
      return void res.end();
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      return page(res, 400, 'Sign-out request refused', e.message);
    }
  }
  if (req.method === 'GET' && url.pathname === '/auth/signed-out') {
    const message = url.searchParams.has('unconfirmed')
      ? 'Your Plan Ops Hub session has ended. Your organization’s identity provider didn’t confirm that it signed you out too; close your browser to be sure.'
      : (await auth.providerLogout())
        ? 'You’re signed out of Plan Ops Hub and of your organization’s sign-in.'
        : 'Your Plan Ops Hub session has ended. You may still be signed in to your organization’s identity provider.';
    return page(res, 200, 'You’re signed out', message, { href: '/auth/login', label: 'Sign in again' });
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
        if (app.auth.mode !== 'dev') {
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
          const can = (p: Permission) => app.users.can(me, p);
          if (r.perm && !r.perm.some(can)) {
            throw new ForbiddenError(app.users.roles.isReadOnly(me) ? 'Auditors have read-only access' : `This action needs the ${r.perm.join(' or ')} permission`);
          }
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = req.method === 'GET' ? {} : await readBody(req);
          const result = await r.handler({ app, params, body, query: url.searchParams, actor, me, can, scope: clientScope(app, me) });
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
    console.log(`Plan Ops Hub on http://${host === '0.0.0.0' ? 'localhost' : host}:${p} (${app.auth.mode === 'dev' ? 'development mode: no sign-in, localhost only' : `single sign-on (${app.auth.mode.toUpperCase()})`})`);
  });
  return server;
}


import type { Collection } from '../store/db.ts';
import type { Clock } from '../domain/util.ts';
import { newId } from '../domain/util.ts';
import { IntegrationRegistry, type AuthDef, type CompiledSystem } from './registry.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface HttpResponse {
  status: number;
  body: string;
}
/** Sends one HTTP request. The default uses fetch; `mock://` URLs go to in-process mock systems. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
/** An in-process mock system (for demos and tests): same request/response contract as HTTP. */
export type MockHandler = (req: { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown }) => Promise<HttpResponse> | HttpResponse;

export class IntegrationError extends Error {
  status?: number;
  system: string;
  operation: string;
  retryable: boolean;
  constructor(system: string, operation: string, message: string, status?: number, retryable = false) {
    super(`${system}.${operation}: ${message}`);
    this.system = system;
    this.operation = operation;
    this.status = status;
    this.retryable = retryable;
  }
}

/** One entry per call. Bodies and secrets are never stored, because they can hold personal data or credentials. */
export interface CallLogEntry {
  id: string;
  at: string;
  system: string;
  operation: string;
  method: string;
  path: string;
  status: number | null;
  ok: boolean;
  attempts: number;
  durationMs: number;
  error?: string;
  caseId?: string;
  taskId?: string;
  actor?: string;
}

export interface CallOptions {
  /** Data request templates can read: plan, request, case, steps, today, client. */
  context?: Record<string, unknown>;
  input?: unknown;
  /** Sent on writes so a retried call is applied once (e.g. caseId:stepId). */
  idempotencyKey?: string;
  caseId?: string;
  taskId?: string;
  actor?: string;
}

export interface CallResult {
  data: unknown;
  status: number;
  attempts: number;
  durationMs: number;
  callId: string;
}

export interface ClientOptions {
  transport?: Transport;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export class IntegrationClient {
  readonly registry: IntegrationRegistry;
  private log: Collection<CallLogEntry>;
  private clock: Clock;
  private mocks = new Map<string, MockHandler>();
  private transport: Transport;
  private env: Record<string, string | undefined>;
  private sleep: (ms: number) => Promise<void>;
  private tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(registry: IntegrationRegistry, log: Collection<CallLogEntry>, clock: Clock, opts: ClientOptions = {}) {
    this.registry = registry;
    this.log = log;
    this.clock = clock;
    this.env = opts.env ?? process.env;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const http = opts.transport ?? fetchTransport;
    this.transport = (req) => (req.url.startsWith('mock://') ? this.dispatchMock(req) : http(req));
  }

  /** Register an in-process mock system reachable at mock://<name>. */
  registerMock(name: string, handler: MockHandler): void {
    this.mocks.set(name, handler);
  }

  async call(system: string, operation: string, opts: CallOptions = {}): Promise<CallResult> {
    const sys = this.registry.system(system);
    const op = this.registry.operation(system, operation);
    const ctx = { ...(opts.context ?? {}), input: opts.input ?? {} };

    let path: string;
    let url: string;
    let body: string | undefined;
    const headers: Record<string, string> = { accept: 'application/json' };
    try {
      path = op.path(ctx);
      const q = new URLSearchParams();
      for (const [k, f] of op.query) {
        const v = f(ctx);
        if (v !== '') q.set(k, v);
      }
      url = sys.baseUrl + path + (q.size ? `?${q}` : '');
      if (op.body) {
        body = JSON.stringify(op.body(ctx));
        headers['content-type'] = 'application/json';
      }
    } catch (e) {
      throw new IntegrationError(system, operation, `could not build request: ${(e as Error).message}`);
    }
    if (opts.idempotencyKey && op.def.method !== 'GET') headers[(sys.def.idempotencyHeader ?? 'Idempotency-Key').toLowerCase()] = opts.idempotencyKey;

    const retryable = op.def.method === 'GET' || !!op.def.idempotent;
    const maxAttempts = retryable ? Math.max(1, sys.def.retry?.attempts ?? 3) : 1;
    const backoff = sys.def.retry?.backoffMs ?? 250;
    const retryOn = sys.def.retry?.onStatus ?? RETRY_STATUSES;
    const started = Date.now();
    let attempts = 0;
    let lastError: IntegrationError | undefined;
    let res: HttpResponse | undefined;

    for (; attempts < maxAttempts; ) {
      attempts++;
      try {
        const auth = await this.authHeaders(sys);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), sys.def.timeoutMs ?? 10_000);
        try {
          res = await this.transport({ method: op.def.method, url, headers: { ...headers, ...auth }, body, signal: ctl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (res.status >= 200 && res.status < 300) {
          lastError = undefined;
          break;
        }
        if (res.status === 401 && sys.def.auth?.type === 'oauth2ClientCredentials') this.tokens.delete(sys.def.id);
        lastError = new IntegrationError(system, operation, `${res.status} ${errorText(res.body)}`, res.status, retryOn.includes(res.status));
      } catch (e) {
        if (e instanceof IntegrationError) lastError = e;
        else {
          const msg = (e as Error).name === 'AbortError' ? `timed out after ${sys.def.timeoutMs ?? 10_000} ms` : `could not connect (${(e as Error).message})`;
          lastError = new IntegrationError(system, operation, msg, undefined, true);
        }
      }
      if (!lastError.retryable || attempts >= maxAttempts) break;
      await this.sleep(backoff * 2 ** (attempts - 1));
    }

    const entry: CallLogEntry = {
      id: newId('call'),
      at: this.clock.now().toISOString(),
      system,
      operation,
      method: op.def.method,
      path,
      status: res?.status ?? null,
      ok: !lastError,
      attempts,
      durationMs: Date.now() - started,
      error: lastError?.message,
      caseId: opts.caseId,
      taskId: opts.taskId,
      actor: opts.actor,
    };
    this.log.insert(entry);
    if (lastError) {
      lastError.message += attempts > 1 ? ` (after ${attempts} attempts)` : '';
      throw lastError;
    }

    let parsed: unknown = null;
    if (res!.body) {
      try {
        parsed = JSON.parse(res!.body);
      } catch {
        throw new IntegrationError(system, operation, 'response was not valid JSON', res!.status);
      }
    }
    let data: unknown = parsed;
    if (op.response) {
      try {
        data = op.response({ response: parsed, status: res!.status, input: opts.input ?? {} });
      } catch (e) {
        throw new IntegrationError(system, operation, `could not read response: ${(e as Error).message}`, res!.status);
      }
    }
    return { data, status: res!.status, attempts, durationMs: entry.durationMs, callId: entry.id };
  }

  /** Runs the system's health-check operation. */
  async test(system: string): Promise<{ ok: boolean; message: string; durationMs?: number }> {
    const sys = this.registry.system(system);
    if (!sys.def.healthCheck) return { ok: false, message: 'No healthCheck operation configured' };
    try {
      const r = await this.call(system, sys.def.healthCheck, { actor: 'admin' });
      return { ok: true, message: `Reachable (${r.status})`, durationMs: r.durationMs };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  calls(limit = 100): CallLogEntry[] {
    return this.log.all().reverse().slice(0, limit);
  }

  /** Which secrets a system needs and whether each is set (never the values). */
  secretStatus(sys: CompiledSystem): { env: string; set: boolean }[] {
    const a = sys.def.auth;
    const names = !a || a.type === 'none' ? [] : a.type === 'apiKey' ? [a.secretEnv] : a.type === 'bearer' ? [a.tokenEnv] : a.type === 'basic' ? [a.userEnv, a.passwordEnv] : [a.clientIdEnv, a.clientSecretEnv];
    return names.map((env) => ({ env, set: !!this.env[env] || sys.baseUrl.startsWith('mock://') }));
  }

  private secret(sys: CompiledSystem, name: string): string {
    const v = this.env[name];
    if (v) return v;
    // Mock systems accept a placeholder so demos and tests need no configuration.
    if (sys.baseUrl.startsWith('mock://')) return `mock-${name.toLowerCase()}`;
    throw new IntegrationError(sys.def.id, '-', `secret ${name} is not set in the environment`);
  }

  private async authHeaders(sys: CompiledSystem): Promise<Record<string, string>> {
    const a: AuthDef = sys.def.auth ?? { type: 'none' };
    switch (a.type) {
      case 'none':
        return {};
      case 'apiKey':
        return { [a.header.toLowerCase()]: this.secret(sys, a.secretEnv) };
      case 'bearer':
        return { authorization: `Bearer ${this.secret(sys, a.tokenEnv)}` };
      case 'basic':
        return { authorization: `Basic ${Buffer.from(`${this.secret(sys, a.userEnv)}:${this.secret(sys, a.passwordEnv)}`).toString('base64')}` };
      case 'oauth2ClientCredentials': {
        const cached = this.tokens.get(sys.def.id);
        if (cached && cached.expiresAt > Date.now() + 30_000) return { authorization: `Bearer ${cached.token}` };
        const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.secret(sys, a.clientIdEnv), client_secret: this.secret(sys, a.clientSecretEnv) });
        if (a.scope) form.set('scope', a.scope);
        const res = await this.transport({ method: 'POST', url: a.tokenUrl, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
        if (res.status !== 200) throw new IntegrationError(sys.def.id, 'oauth2', `token request failed (${res.status})`, res.status, res.status >= 500);
        const t = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
        if (!t.access_token) throw new IntegrationError(sys.def.id, 'oauth2', 'token response had no access_token');
        this.tokens.set(sys.def.id, { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 300) * 1000 });
        return { authorization: `Bearer ${t.access_token}` };
      }
    }
  }

  private async dispatchMock(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url.replace(/^mock:\/\//, 'http://'));
    const handler = this.mocks.get(u.hostname);
    if (!handler) throw new Error(`no mock system registered for ${u.hostname}`);
    return handler({ method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, body: req.body ? JSON.parse(req.body) : undefined });
  }
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string; message?: string };
    return String(j.error ?? j.message ?? body).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
  return { status: res.status, body: await res.text() };
};

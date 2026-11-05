import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileTemplate, RuleError, type Compiled } from '../rules/expression.ts';

/**
 * External systems are configuration (config/integrations/*.json): where they
 * are, how to authenticate, retry/timeout policy, and the operations the hub may
 * call, including how request bodies are built from case data and how responses
 * are mapped back. Secrets are never in the files; they're named environment
 * variables.
 */

export type AuthDef =
  | { type: 'none' }
  | { type: 'apiKey'; header: string; secretEnv: string }
  | { type: 'bearer'; tokenEnv: string }
  | { type: 'basic'; userEnv: string; passwordEnv: string }
  | { type: 'oauth2ClientCredentials'; tokenUrl: string; clientIdEnv: string; clientSecretEnv: string; scope?: string };

export interface OperationDef {
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template, e.g. "/plans/{{plan.tracPlanId}}". Values are URL-encoded. */
  path: string;
  query?: Record<string, string>;
  /** JSON body template. A string starting with "=" is an expression, e.g. "=plan.details.ein". */
  body?: unknown;
  /** Safe to retry: GETs always are; writes only when the system de-duplicates (idempotency key). */
  idempotent?: boolean;
  /** Has no side effects even though it may use POST (e.g. a lookup). Only read-only operations can be AI agent tools. */
  readOnly?: boolean;
  /** Map the response: one expression, or an object of field -> expression. Can read response, status, input. */
  response?: string | Record<string, string>;
}

export interface SystemDef {
  id: string;
  name: string;
  description?: string;
  /** May reference environment variables: "${TRAC_BASE_URL:-mock://trac}". */
  baseUrl: string;
  auth?: AuthDef;
  timeoutMs?: number;
  retry?: { attempts?: number; backoffMs?: number; onStatus?: number[] };
  /** Header used to send the idempotency key on writes. */
  idempotencyHeader?: string;
  /** Operation used by "Test connection". */
  healthCheck?: string;
  operations: Record<string, OperationDef>;
}

/** Data request templates can read. `input` is what the caller (or the step's params.input) passes in. */
export const REQUEST_ROOTS = ['input', 'plan', 'request', 'case', 'steps', 'today', 'client'] as const;
export const RESPONSE_ROOTS = ['response', 'status', 'input'] as const;

type BodyTemplate = (ctx: Record<string, unknown>) => unknown;

export interface CompiledOperation {
  system: string;
  name: string;
  def: OperationDef;
  path: (ctx: Record<string, unknown>) => string;
  query: [string, (ctx: Record<string, unknown>) => string][];
  body?: BodyTemplate;
  response?: (ctx: Record<string, unknown>) => unknown;
}

export interface CompiledSystem {
  def: SystemDef;
  baseUrl: string;
  operations: Map<string, CompiledOperation>;
}

/** "${NAME}" or "${NAME:-default}" from the environment. */
export function resolveEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    throw new RuleError(`Environment variable ${name} is not set`);
  });
}

/** Compile a JSON template: strings starting with "=" are expressions, everything else is literal. */
export function compileBody(t: unknown, roots: readonly string[], where = 'template'): BodyTemplate {
  if (typeof t === 'string' && t.startsWith('=')) {
    const c = compile(t.slice(1), roots);
    return (ctx) => c.eval(ctx);
  }
  if (Array.isArray(t)) {
    const items = t.map((x, i) => compileBody(x, roots, `${where}[${i}]`));
    return (ctx) => items.map((f) => f(ctx));
  }
  if (t && typeof t === 'object') {
    const entries = Object.entries(t).map(([k, v]) => [k, compileBody(v, roots, `${where}.${k}`)] as const);
    return (ctx) => Object.fromEntries(entries.map(([k, f]) => [k, f(ctx)]));
  }
  return () => t;
}

function compileOperation(system: string, name: string, def: OperationDef): CompiledOperation {
  const where = `Integration ${system}.${name}`;
  const wrap = <T>(part: string, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw new RuleError(`${where} ${part}: ${(e as Error).message}`);
    }
  };
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(def.method)) throw new RuleError(`${where}: unsupported method ${def.method}`);
  if (!def.path?.startsWith('/')) throw new RuleError(`${where}: path must start with "/"`);
  // Path placeholders are URL-encoded so data can't change the route (e.g. "../admin").
  const pathParts = wrap('path', () => {
    const parts: (string | Compiled)[] = [];
    let last = 0;
    for (const m of def.path.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
      parts.push(def.path.slice(last, m.index));
      parts.push(compile(m[1].trim(), REQUEST_ROOTS));
      last = m.index! + m[0].length;
    }
    parts.push(def.path.slice(last));
    return parts;
  });
  let response: CompiledOperation['response'];
  if (typeof def.response === 'string') {
    const c = wrap('response', () => compile(def.response as string, RESPONSE_ROOTS));
    response = (ctx) => c.eval(ctx);
  } else if (def.response) {
    const fields = Object.entries(def.response).map(([k, v]) => [k, wrap(`response.${k}`, () => compile(v, RESPONSE_ROOTS))] as const);
    response = (ctx) => Object.fromEntries(fields.map(([k, c]) => [k, c.eval(ctx) ?? null]));
  }
  return {
    system,
    name,
    def,
    path: (ctx) =>
      pathParts
        .map((p) => {
          if (typeof p === 'string') return p;
          const v = p.eval(ctx);
          if (v === null || v === undefined || v === '') throw new RuleError(`${where}: path value ${p.source} is missing`);
          return encodeURIComponent(String(v));
        })
        .join(''),
    query: Object.entries(def.query ?? {}).map(([k, v]) => [k, wrap(`query.${k}`, () => compileTemplate(v, REQUEST_ROOTS))]),
    body: def.body === undefined ? undefined : wrap('body', () => compileBody(def.body, REQUEST_ROOTS, 'body')),
    response,
  };
}

export function compileSystem(def: SystemDef, env: Record<string, string | undefined> = process.env): CompiledSystem {
  if (!def.id || !/^[a-z0-9-]+$/.test(def.id)) throw new RuleError(`Integration id "${def.id}" must be lower-case letters, digits and dashes`);
  const baseUrl = resolveEnv(def.baseUrl, env).replace(/\/$/, '');
  if (!/^(https?|mock):\/\//.test(baseUrl)) throw new RuleError(`Integration ${def.id}: baseUrl must be http(s):// or mock://`);
  if (baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) {
    throw new RuleError(`Integration ${def.id}: plain http is only allowed for localhost; use https`);
  }
  const operations = new Map<string, CompiledOperation>();
  for (const [name, op] of Object.entries(def.operations ?? {})) operations.set(name, compileOperation(def.id, name, op));
  if (def.healthCheck && !operations.has(def.healthCheck)) throw new RuleError(`Integration ${def.id}: healthCheck "${def.healthCheck}" is not an operation`);
  return { def, baseUrl, operations };
}

export class IntegrationRegistry {
  private systems = new Map<string, CompiledSystem>();

  constructor(dir?: string, env: Record<string, string | undefined> = process.env) {
    if (!dir || !existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let def: SystemDef;
      try {
        def = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SystemDef;
      } catch (e) {
        throw new RuleError(`${f}: invalid JSON (${(e as Error).message})`);
      }
      this.add(def, env);
    }
  }

  add(def: SystemDef, env: Record<string, string | undefined> = process.env): void {
    if (this.systems.has(def.id)) throw new RuleError(`Duplicate integration id "${def.id}"`);
    this.systems.set(def.id, compileSystem(def, env));
  }

  list(): CompiledSystem[] {
    return [...this.systems.values()];
  }

  system(id: string): CompiledSystem {
    const s = this.systems.get(id);
    if (!s) throw new RuleError(`Unknown integration "${id}"`);
    return s;
  }

  operation(system: string, op: string): CompiledOperation {
    const o = this.system(system).operations.get(op);
    if (!o) throw new RuleError(`Integration ${system} has no operation "${op}"`);
    return o;
  }

  has(system: string, op?: string): boolean {
    const s = this.systems.get(system);
    return !!s && (op === undefined || s.operations.has(op));
  }
}

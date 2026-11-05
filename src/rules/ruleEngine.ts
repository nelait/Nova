import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileTemplate, RuleError, type Compiled } from './expression.ts';

/** Names every rule expression may read. */
export const CONTEXT_ROOTS = ['plan', 'request', 'case', 'steps', 'today', 'client', 'decisions', 'outputs'] as const;
/** Names a step condition (`when` on a playbook step) may read. */
export const STEP_CONDITION_ROOTS = ['plan', 'request', 'case', 'steps', 'today', 'client'] as const;

export type Severity = 'error' | 'warning' | 'info';
export type OutputFormat = 'usd' | 'number' | 'date' | 'text' | 'percent' | 'boolean';

/** A rule set as written in config/rules/*.json. */
export interface RuleSetDef {
  id: string;
  version: number;
  name: string;
  description?: string;
  /** Decision tables: the first row whose `when` is true supplies values. A row with no `when` is the default. */
  decisions?: { id: string; description?: string; rows: { when?: string; then: Record<string, unknown> }[] }[];
  /** Calculated values, evaluated in order; later outputs can use earlier ones via `outputs.<name>`. */
  outputs?: { name: string; label?: string; expr: string; format?: OutputFormat; description?: string }[];
  /** Checks. A rule fails when `assert` is false; `when` limits when it applies. */
  rules?: { id: string; description?: string; when?: string; assert: string; severity?: Severity; message: string; reference?: string }[];
  /** Examples that must keep passing; run by the test suite and from the Rules screen. */
  tests?: RuleTest[];
}

export interface RuleTest {
  name: string;
  context: Record<string, unknown>;
  expect: {
    passed?: boolean;
    /** Exact set of rule ids that should fail. */
    failing?: string[];
    outputs?: Record<string, unknown>;
    decisions?: Record<string, Record<string, unknown>>;
  };
}

export interface Issue {
  ruleId: string;
  severity: Severity;
  message: string;
  reference?: string;
}

export interface TraceEntry {
  kind: 'decision' | 'output' | 'rule';
  id: string;
  outcome: 'pass' | 'fail' | 'skipped' | 'value' | 'error';
  detail?: unknown;
}

export interface RuleResult {
  ruleSet: string;
  version: number;
  name: string;
  /** False when any error-severity rule failed (or could not be evaluated). */
  passed: boolean;
  issues: Issue[];
  outputs: Record<string, unknown>;
  outputMeta: { name: string; label: string; format: OutputFormat }[];
  decisions: Record<string, Record<string, unknown> & { row: number }>;
  trace: TraceEntry[];
}

interface CompiledSet {
  def: RuleSetDef;
  decisions: { id: string; rows: { when?: Compiled; then: Record<string, unknown> }[] }[];
  outputs: { name: string; label: string; format: OutputFormat; expr: Compiled }[];
  rules: { id: string; when?: Compiled; assert: Compiled; severity: Severity; message: (c: Record<string, unknown>) => string; reference?: string; description?: string }[];
}

export function compileRuleSet(def: RuleSetDef): CompiledSet {
  const where = (part: string) => `Rule set ${def.id}: ${part}`;
  if (!def.id || typeof def.version !== 'number') throw new RuleError(where('needs id and numeric version'));
  const roots = CONTEXT_ROOTS;
  const seen = new Set<string>();
  const unique = (kind: string, id: string) => {
    if (!id) throw new RuleError(where(`${kind} without id`));
    if (seen.has(`${kind}:${id}`)) throw new RuleError(where(`duplicate ${kind} "${id}"`));
    seen.add(`${kind}:${id}`);
  };
  const wrap = <T>(part: string, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw new RuleError(where(`${part}: ${(e as Error).message}`));
    }
  };
  return {
    def,
    decisions: (def.decisions ?? []).map((d) => {
      unique('decision', d.id);
      if (!d.rows?.length) throw new RuleError(where(`decision "${d.id}" has no rows`));
      return {
        id: d.id,
        rows: d.rows.map((r, i) => ({ when: r.when ? wrap(`decision "${d.id}" row ${i + 1}`, () => compile(r.when!, roots)) : undefined, then: r.then ?? {} })),
      };
    }),
    outputs: (def.outputs ?? []).map((o) => {
      unique('output', o.name);
      return { name: o.name, label: o.label ?? o.name, format: o.format ?? 'text', expr: wrap(`output "${o.name}"`, () => compile(o.expr, roots)) };
    }),
    rules: (def.rules ?? []).map((r) => {
      unique('rule', r.id);
      return {
        id: r.id,
        description: r.description,
        when: r.when ? wrap(`rule "${r.id}" when`, () => compile(r.when!, roots)) : undefined,
        assert: wrap(`rule "${r.id}" assert`, () => compile(r.assert, roots)),
        severity: r.severity ?? 'error',
        message: wrap(`rule "${r.id}" message`, () => compileTemplate(r.message, roots)),
        reference: r.reference,
      };
    }),
  };
}

/** Evaluation order: decision tables, then outputs, then rules (which can use both). */
export function evaluateRuleSet(set: CompiledSet, input: Record<string, unknown>): RuleResult {
  const decisions: RuleResult['decisions'] = {};
  const outputs: Record<string, unknown> = {};
  const ctx: Record<string, unknown> = { ...input, decisions, outputs };
  const issues: Issue[] = [];
  const trace: TraceEntry[] = [];
  const fail = (kind: TraceEntry['kind'], id: string, e: unknown) => {
    const msg = (e as Error).message;
    issues.push({ ruleId: id, severity: 'error', message: `${kind === 'output' ? 'Could not calculate' : kind === 'decision' ? 'Could not decide' : 'Could not evaluate'} "${id}": ${msg}` });
    trace.push({ kind, id, outcome: 'error', detail: msg });
  };

  for (const d of set.decisions) {
    try {
      const i = d.rows.findIndex((r) => !r.when || r.when.test(ctx));
      if (i === -1) throw new RuleError('no row matched and there is no default row');
      decisions[d.id] = { ...d.rows[i].then, row: i + 1 };
      trace.push({ kind: 'decision', id: d.id, outcome: 'value', detail: { row: i + 1, ...d.rows[i].then } });
    } catch (e) {
      fail('decision', d.id, e);
    }
  }
  for (const o of set.outputs) {
    try {
      outputs[o.name] = o.expr.eval(ctx) ?? null;
      trace.push({ kind: 'output', id: o.name, outcome: 'value', detail: outputs[o.name] });
    } catch (e) {
      outputs[o.name] = null;
      fail('output', o.name, e);
    }
  }
  for (const r of set.rules) {
    try {
      if (r.when && !r.when.test(ctx)) {
        trace.push({ kind: 'rule', id: r.id, outcome: 'skipped' });
        continue;
      }
      if (r.assert.test(ctx)) {
        trace.push({ kind: 'rule', id: r.id, outcome: 'pass' });
        continue;
      }
      let message: string;
      try {
        message = r.message(ctx);
      } catch {
        message = r.description ?? r.id;
      }
      issues.push({ ruleId: r.id, severity: r.severity, message, reference: r.reference });
      trace.push({ kind: 'rule', id: r.id, outcome: 'fail', detail: { severity: r.severity } });
    } catch (e) {
      fail('rule', r.id, e);
    }
  }
  return {
    ruleSet: set.def.id,
    version: set.def.version,
    name: set.def.name,
    passed: !issues.some((i) => i.severity === 'error'),
    issues,
    outputs,
    outputMeta: set.outputs.map((o) => ({ name: o.name, label: o.label, format: o.format })),
    decisions,
    trace,
  };
}

export interface TestOutcome {
  name: string;
  passed: boolean;
  failures: string[];
}

export function runRuleTests(set: CompiledSet): TestOutcome[] {
  return (set.def.tests ?? []).map((t) => {
    const r = evaluateRuleSet(set, t.context);
    const failures: string[] = [];
    if (t.expect.passed !== undefined && r.passed !== t.expect.passed) failures.push(`expected passed=${t.expect.passed}, got ${r.passed}`);
    if (t.expect.failing) {
      const got = [...new Set(r.issues.map((i) => i.ruleId))].sort();
      const want = [...t.expect.failing].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`expected failing [${want.join(', ')}], got [${got.join(', ')}]`);
    }
    for (const [k, v] of Object.entries(t.expect.outputs ?? {})) {
      if (JSON.stringify(r.outputs[k]) !== JSON.stringify(v)) failures.push(`output ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(r.outputs[k])}`);
    }
    for (const [id, fields] of Object.entries(t.expect.decisions ?? {})) {
      for (const [k, v] of Object.entries(fields)) {
        const got = r.decisions[id]?.[k];
        if (JSON.stringify(got) !== JSON.stringify(v)) failures.push(`decision ${id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      }
    }
    return { name: t.name, passed: failures.length === 0, failures };
  });
}

/** Loads and compiles every rule set in config/rules. Any error stops startup. */
export class RuleRegistry {
  private sets = new Map<string, CompiledSet>();

  constructor(dir?: string) {
    if (!dir || !existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let def: RuleSetDef;
      try {
        def = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RuleSetDef;
      } catch (e) {
        throw new RuleError(`${f}: invalid JSON (${(e as Error).message})`);
      }
      this.add(def);
    }
  }

  add(def: RuleSetDef): void {
    if (this.sets.has(def.id)) throw new RuleError(`Duplicate rule set id "${def.id}"`);
    this.sets.set(def.id, compileRuleSet(def));
  }

  has(id: string): boolean {
    return this.sets.has(id);
  }

  list(): RuleSetDef[] {
    return [...this.sets.values()].map((s) => s.def);
  }

  get(id: string): RuleSetDef {
    return this.require(id).def;
  }

  evaluate(id: string, context: Record<string, unknown>): RuleResult {
    return evaluateRuleSet(this.require(id), context);
  }

  test(id: string): TestOutcome[] {
    return runRuleTests(this.require(id));
  }

  private require(id: string): CompiledSet {
    const s = this.sets.get(id);
    if (!s) throw new RuleError(`Unknown rule set "${id}"`);
    return s;
  }
}

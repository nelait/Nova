// A small, safe expression language for business rules.
//
//   plan.details.employeeCount >= 100 and countWhere(plan.details.funds, 'qdia', true) == 1
//   round(outputs.planAssetsUsd * plan.details.fees.recordkeepingBps / 10000, 2)
//   steps["validate-intake"].decisions.segment.name != 'small'
//
// Expressions are parsed by hand (no eval / Function), can only read the context
// they are given (own properties only, no prototypes), can only call the
// whitelisted functions below, and are compiled when configuration loads so a
// typo fails at startup rather than in the middle of a case.

export class RuleError extends Error {}

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'id'; name: string }
  | { t: 'mem'; obj: Node; key: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'not'; a: Node }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'and' | 'or'; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'list'; items: Node[] };

type Tok = { k: 'num' | 'str' | 'id' | 'op'; v: string; pos: number };

const MAX_LENGTH = 2000;
const MAX_DEPTH = 64;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LENGTH) throw new RuleError(`Expression longer than ${MAX_LENGTH} characters`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (/[0-9_]/.test(src[i] ?? '')) i++;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (/[0-9]/.test(src[i] ?? '')) i++;
      }
      out.push({ k: 'num', v: src.slice(start, i).replace(/_/g, ''), pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let s = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== c) throw new RuleError(`Unterminated string at position ${start}`);
      i++;
      out.push({ k: 'str', v: s, pos: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (/[A-Za-z0-9_$]/.test(src[i] ?? '')) i++;
      out.push({ k: 'id', v: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>!?:.,()[]'.includes(c)) {
      out.push({ k: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new RuleError(`Unexpected character "${c}" at position ${i}`);
  }
  return out;
}

class Parser {
  private toks: Tok[];
  private i = 0;
  private depth = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.k === 'op' && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return !!t && t.k === 'id' && t.v === v;
  }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new RuleError(`Expected "${v}" ${this.where()}`);
    this.i++;
  }
  private where(): string {
    const t = this.peek();
    return t ? `at position ${t.pos} (found "${t.v}")` : 'at end of expression';
  }
  parse(): Node {
    const n = this.expr();
    if (this.peek()) throw new RuleError(`Unexpected "${this.peek()!.v}" ${this.where()}`);
    return n;
  }
  private expr(): Node {
    if (++this.depth > MAX_DEPTH) throw new RuleError('Expression is nested too deeply');
    const c = this.or();
    let n = c;
    if (this.isOp('?')) {
      this.i++;
      const a = this.expr();
      this.expect(':');
      const b = this.expr();
      n = { t: 'cond', c, a, b };
    }
    this.depth--;
    return n;
  }
  private or(): Node {
    let a = this.and();
    while (this.isOp('||') || this.isWord('or')) {
      this.i++;
      a = { t: 'or', a, b: this.and() };
    }
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.isOp('&&') || this.isWord('and')) {
      this.i++;
      a = { t: 'and', a, b: this.not() };
    }
    return a;
  }
  private not(): Node {
    if (this.isOp('!') || this.isWord('not')) {
      this.i++;
      return { t: 'not', a: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Node {
    const a = this.add();
    const t = this.peek();
    if (t && ((t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) || (t.k === 'id' && t.v === 'in'))) {
      this.i++;
      return { t: 'bin', op: t.v, a, b: this.add() };
    }
    return a;
  }
  private add(): Node {
    let a = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.toks[this.i++].v;
      a = { t: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  private mul(): Node {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.toks[this.i++].v;
      a = { t: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { t: 'neg', a: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.i++;
        const t = this.peek();
        if (!t || t.k !== 'id') throw new RuleError(`Expected a field name after "." ${this.where()}`);
        this.i++;
        n = { t: 'mem', obj: n, key: { t: 'lit', v: t.v } };
      } else if (this.isOp('[')) {
        this.i++;
        const key = this.expr();
        this.expect(']');
        n = { t: 'mem', obj: n, key };
      } else return n;
    }
  }
  private primary(): Node {
    const t = this.peek();
    if (!t) throw new RuleError('Unexpected end of expression');
    this.i++;
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const n = this.expr();
      this.expect(')');
      return n;
    }
    if (t.k === 'op' && t.v === '[') {
      const items: Node[] = [];
      if (!this.isOp(']')) {
        do items.push(this.expr());
        while (this.isOp(',') && ++this.i);
      }
      this.expect(']');
      return { t: 'list', items };
    }
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          do args.push(this.expr());
          while (this.isOp(',') && ++this.i);
        }
        this.expect(')');
        return { t: 'call', fn: t.v, args };
      }
      return { t: 'id', name: t.v };
    }
    throw new RuleError(`Unexpected "${t.v}" at position ${t.pos}`);
  }
}

// ------------------------------------------------------------------ functions

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const regexCache = new Map<string, RegExp>();

function toDate(v: unknown, fn: string): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !ISO_DATE.test(v)) throw new RuleError(`${fn}: expected a YYYY-MM-DD date, got ${JSON.stringify(v)}`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RuleError(`${fn}: invalid date ${v}`);
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const list = (v: unknown, fn: string): unknown[] => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new RuleError(`${fn}: expected a list`);
  return v;
};
const num = (v: unknown, fn: string): number => {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new RuleError(`${fn}: expected a number, got ${JSON.stringify(v)}`);
  return v;
};
const field = (item: unknown, f: unknown) => (item && typeof item === 'object' && Object.hasOwn(item, String(f)) ? (item as Record<string, unknown>)[String(f)] : undefined);

type Fn = { arity: [number, number]; doc: string; impl: (...a: unknown[]) => unknown };

export const FUNCTIONS: Record<string, Fn> = {
  len: { arity: [1, 1], doc: 'Length of a list or text (0 when missing)', impl: (v) => (v === null || v === undefined ? 0 : typeof v === 'string' || Array.isArray(v) ? v.length : 0) },
  isBlank: { arity: [1, 1], doc: 'True when missing, empty text or empty list', impl: (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) },
  isNumber: { arity: [1, 1], doc: 'True when the value is a number', impl: (v) => typeof v === 'number' && !Number.isNaN(v) },
  isDate: {
    arity: [1, 1],
    doc: 'True when the value is a valid YYYY-MM-DD date',
    impl: (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && iso(new Date(`${v}T00:00:00Z`)) === v,
  },
  coalesce: { arity: [1, 10], doc: 'First argument that is not missing', impl: (...a) => a.find((x) => x !== null && x !== undefined) ?? null },
  countWhere: { arity: [3, 3], doc: 'Number of items whose field equals a value', impl: (l, f, v) => list(l, 'countWhere').filter((x) => field(x, f) === v).length },
  any: { arity: [3, 3], doc: 'True when any item has field equal to value', impl: (l, f, v) => list(l, 'any').some((x) => field(x, f) === v) },
  find: { arity: [3, 3], doc: 'First item whose field equals value, or null', impl: (l, f, v) => list(l, 'find').find((x) => field(x, f) === v) ?? null },
  pluck: { arity: [2, 2], doc: 'List of one field from each item', impl: (l, f) => list(l, 'pluck').map((x) => field(x, f)) },
  hasDuplicates: { arity: [1, 1], doc: 'True when a list has repeated values', impl: (l) => new Set(list(l, 'hasDuplicates')).size !== list(l, 'hasDuplicates').length },
  sum: { arity: [1, 1], doc: 'Sum of a list of numbers', impl: (l) => list(l, 'sum').reduce<number>((a, x) => a + num(x, 'sum'), 0) },
  min: { arity: [1, 10], doc: 'Smallest number', impl: (...a) => Math.min(...a.map((x) => num(x, 'min'))) },
  max: { arity: [1, 10], doc: 'Largest number', impl: (...a) => Math.max(...a.map((x) => num(x, 'max'))) },
  abs: { arity: [1, 1], doc: 'Absolute value', impl: (x) => Math.abs(num(x, 'abs')) },
  round: {
    arity: [1, 2],
    doc: 'Round to N decimal places (default 0)',
    impl: (x, d = 0) => {
      const f = 10 ** num(d, 'round');
      return Math.round(num(x, 'round') * f) / f;
    },
  },
  floor: { arity: [1, 1], doc: 'Round down', impl: (x) => Math.floor(num(x, 'floor')) },
  ceil: { arity: [1, 1], doc: 'Round up', impl: (x) => Math.ceil(num(x, 'ceil')) },
  lower: { arity: [1, 1], doc: 'Lower-case text', impl: (s) => String(s ?? '').toLowerCase() },
  upper: { arity: [1, 1], doc: 'Upper-case text', impl: (s) => String(s ?? '').toUpperCase() },
  trim: { arity: [1, 1], doc: 'Trim whitespace', impl: (s) => String(s ?? '').trim() },
  startsWith: { arity: [2, 2], doc: 'Text starts with', impl: (s, p) => String(s ?? '').startsWith(String(p)) },
  endsWith: { arity: [2, 2], doc: 'Text ends with', impl: (s, p) => String(s ?? '').endsWith(String(p)) },
  emailDomain: { arity: [1, 1], doc: 'Lower-case domain of an email address, or null', impl: (s) => (typeof s === 'string' && s.includes('@') ? s.split('@').pop()!.trim().toLowerCase() : null) },
  contains: { arity: [2, 2], doc: 'List contains value, or text contains text', impl: (h, n) => (Array.isArray(h) ? h.includes(n) : String(h ?? '').includes(String(n))) },
  matches: {
    arity: [2, 2],
    doc: 'Text matches a regular expression (pattern written in configuration)',
    impl: (s, p) => {
      if (typeof p !== 'string' || p.length > 200) throw new RuleError('matches: pattern must be text of at most 200 characters');
      let re = regexCache.get(p);
      if (!re) regexCache.set(p, (re = new RegExp(p)));
      return typeof s === 'string' && s.length <= 1000 && re.test(s);
    },
  },
  daysBetween: {
    arity: [2, 2],
    doc: 'Whole days from the first date to the second (negative if earlier)',
    impl: (a, b) => {
      const x = toDate(a, 'daysBetween');
      const y = toDate(b, 'daysBetween');
      return x && y ? Math.round((y.getTime() - x.getTime()) / DAY) : null;
    },
  },
  addDays: {
    arity: [2, 2],
    doc: 'Date plus N days',
    impl: (a, n) => {
      const d = toDate(a, 'addDays');
      return d ? iso(new Date(d.getTime() + num(n, 'addDays') * DAY)) : null;
    },
  },
  quarterStart: {
    arity: [1, 1],
    doc: 'First day of the calendar quarter containing the date',
    impl: (a) => {
      const d = toDate(a, 'quarterStart');
      return d ? iso(new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))) : null;
    },
  },
  year: { arity: [1, 1], doc: 'Year of a date', impl: (a) => toDate(a, 'year')?.getUTCFullYear() ?? null },
  usd: {
    arity: [1, 1],
    doc: 'Format a number as US dollars, e.g. $1,234.50',
    impl: (x) => '$' + num(x, 'usd').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  },
};

// ------------------------------------------------------------------ evaluation

function truthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
}

function evaluate(n: Node, ctx: Record<string, unknown>): unknown {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'list':
      return n.items.map((x) => evaluate(x, ctx));
    case 'id':
      return Object.hasOwn(ctx, n.name) ? ctx[n.name] : undefined;
    case 'mem': {
      const obj = evaluate(n.obj, ctx);
      const key = evaluate(n.key, ctx);
      if (obj === null || obj === undefined) return undefined; // safe navigation: missing data reads as missing
      const k = String(key);
      if (BLOCKED_KEYS.has(k)) throw new RuleError(`Field "${k}" is not allowed`);
      if (typeof obj !== 'object') return k === 'length' && typeof obj === 'string' ? obj.length : undefined;
      return Object.hasOwn(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
    }
    case 'call':
      return FUNCTIONS[n.fn].impl(...n.args.map((a) => evaluate(a, ctx)));
    case 'not':
      return !truthy(evaluate(n.a, ctx));
    case 'neg':
      return -num(evaluate(n.a, ctx), 'minus');
    case 'and':
      return truthy(evaluate(n.a, ctx)) && truthy(evaluate(n.b, ctx));
    case 'or':
      return truthy(evaluate(n.a, ctx)) || truthy(evaluate(n.b, ctx));
    case 'cond':
      return truthy(evaluate(n.c, ctx)) ? evaluate(n.a, ctx) : evaluate(n.b, ctx);
    case 'bin': {
      const a = evaluate(n.a, ctx);
      const b = evaluate(n.b, ctx);
      switch (n.op) {
        case '==':
          return (a ?? null) === (b ?? null);
        case '!=':
          return (a ?? null) !== (b ?? null);
        case '<':
        case '<=':
        case '>':
        case '>=': {
          // Numbers compare with numbers, text with text (ISO dates compare correctly as text).
          if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) return false;
          return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b;
        }
        case 'in':
          return Array.isArray(b) ? b.includes(a) : typeof b === 'string' ? b.includes(String(a)) : false;
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
          return num(a, '+') + num(b, '+');
        case '-':
          return num(a, '-') - num(b, '-');
        case '*':
          return num(a, '*') * num(b, '*');
        case '/':
        case '%': {
          const d = num(b, n.op);
          if (d === 0) throw new RuleError('Division by zero');
          return n.op === '/' ? num(a, '/') / d : num(a, '%') % d;
        }
      }
    }
  }
  throw new RuleError('Unsupported expression');
}

function check(n: Node, roots: Set<string>): void {
  switch (n.t) {
    case 'id':
      if (!roots.has(n.name)) throw new RuleError(`Unknown name "${n.name}". Available: ${[...roots].join(', ')}`);
      return;
    case 'call': {
      const f = FUNCTIONS[n.fn];
      if (!f || !Object.hasOwn(FUNCTIONS, n.fn)) throw new RuleError(`Unknown function "${n.fn}"`);
      if (n.args.length < f.arity[0] || n.args.length > f.arity[1]) throw new RuleError(`${n.fn} takes ${f.arity[0]}${f.arity[1] !== f.arity[0] ? `-${f.arity[1]}` : ''} argument(s)`);
      n.args.forEach((a) => check(a, roots));
      return;
    }
    case 'mem':
      check(n.obj, roots);
      if (n.key.t === 'lit' && BLOCKED_KEYS.has(String(n.key.v))) throw new RuleError(`Field "${String(n.key.v)}" is not allowed`);
      check(n.key, roots);
      return;
    case 'list':
      n.items.forEach((x) => check(x, roots));
      return;
    case 'not':
    case 'neg':
      check(n.a, roots);
      return;
    case 'bin':
    case 'and':
    case 'or':
      check(n.a, roots);
      check(n.b, roots);
      return;
    case 'cond':
      check(n.c, roots);
      check(n.a, roots);
      check(n.b, roots);
      return;
  }
}

export interface Compiled {
  source: string;
  eval(ctx: Record<string, unknown>): unknown;
  test(ctx: Record<string, unknown>): boolean;
}

/** Parse and validate an expression. `roots` are the top-level names it may use. */
export function compile(source: string, roots: Iterable<string>): Compiled {
  if (typeof source !== 'string' || !source.trim()) throw new RuleError('Expression is empty');
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parse();
    check(ast, new Set(roots));
  } catch (e) {
    throw new RuleError(`${(e as Error).message} in: ${source}`);
  }
  return {
    source,
    eval: (ctx) => evaluate(ast, ctx),
    test: (ctx) => truthy(evaluate(ast, ctx)),
  };
}

/** Compile a message template with {{ expression }} placeholders. */
export function compileTemplate(template: string, roots: Iterable<string>): (ctx: Record<string, unknown>) => string {
  const parts: (string | Compiled)[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
    parts.push(template.slice(last, m.index));
    parts.push(compile(m[1].trim(), roots));
    last = m.index! + m[0].length;
  }
  parts.push(template.slice(last));
  return (ctx) =>
    parts
      .map((p) => {
        if (typeof p === 'string') return p;
        const v = p.eval(ctx);
        return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      })
      .join('');
}

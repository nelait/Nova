/**
 * The JSON Schema subset used for agent outputs. It matches what Claude's
 * structured outputs accept: objects must list every property as required and
 * set additionalProperties: false. Used to check agent definitions at load, and
 * to validate a proposal again when a person edits and approves it.
 */
export type Schema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | ('string' | 'null')[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
};

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** Problems with the schema itself (empty list = usable). */
export function checkSchema(s: Schema, path = '$'): string[] {
  const issues: string[] = [];
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (!types.length && !s.enum) issues.push(`${path}: needs a type or enum`);
  for (const t of types) if (!TYPES.includes(t)) issues.push(`${path}: unsupported type ${t}`);
  if (types.includes('object')) {
    if (s.additionalProperties !== false) issues.push(`${path}: objects must set additionalProperties: false`);
    const props = Object.keys(s.properties ?? {});
    const missing = props.filter((p) => !(s.required ?? []).includes(p));
    if (missing.length) issues.push(`${path}: every property must be required (missing ${missing.join(', ')})`);
    for (const [k, v] of Object.entries(s.properties ?? {})) issues.push(...checkSchema(v, `${path}.${k}`));
  }
  if (types.includes('array')) {
    if (!s.items) issues.push(`${path}: arrays need items`);
    else issues.push(...checkSchema(s.items, `${path}[]`));
  }
  return issues;
}

/** Problems with a value against a schema (empty list = valid). */
export function validate(value: unknown, s: Schema, path = '$'): string[] {
  if (s.enum && !s.enum.includes(value)) return [`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`];
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (!types.length) return [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const ok = types.some((t) => t === actual || (t === 'integer' && Number.isInteger(value)) || (t === 'number' && actual === 'number'));
  if (!ok) return [`${path}: expected ${types.join(' or ')}, got ${actual}`];
  const issues: string[] = [];
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) issues.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const ps = s.properties?.[k];
      if (!ps) {
        if (s.additionalProperties === false) issues.push(`${path}.${k}: not allowed`);
      } else issues.push(...validate(v, ps, `${path}.${k}`));
    }
  }
  if (actual === 'array' && s.items) (value as unknown[]).forEach((v, i) => issues.push(...validate(v, s.items!, `${path}[${i}]`)));
  return issues;
}

/** An empty value that satisfies the schema's shape, for manual entry when no proposal exists. */
export function skeleton(s: Schema): unknown {
  if (s.enum) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, skeleton(v)]));
    case 'array':
      return [];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return '';
  }
}

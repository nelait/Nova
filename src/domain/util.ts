import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

/** Resolve a dotted path like "plan.details.sponsorName" against an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Tiny mustache-style renderer: {{path.to.value}}. Missing values render as [MISSING:path]. */
export function render(template: string, ctx: unknown): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    const v = getPath(ctx, path);
    return v === undefined || v === null || v === '' ? `[MISSING:${path}]` : String(v);
  });
}

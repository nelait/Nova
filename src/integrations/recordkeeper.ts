import type { DatabaseSync } from 'node:sqlite';
import type { Contact, FeeSchedule, Fund } from '../domain/types.ts';
import type { Clock } from '../domain/util.ts';
import { Collection } from '../store/db.ts';
import type { HttpResponse, MockHandler } from './client.ts';

/**
 * Mock TRAC recordkeeper, exposed as a REST API (see config/integrations/trac.json).
 * It uses its own field names (sponsor.name, participants, assetsUsd) so the
 * configured request/response mapping is exercised like it would be against the
 * real system. Point TRAC_BASE_URL at the real API to switch.
 */
export interface TracPlan {
  id: string;
  externalRef: string;
  sponsor: { name: string; ein: string };
  planType: string;
  effectiveDate: string;
  status: 'ACTIVE' | 'TERMINATED';
  contacts: Contact[];
  funds: Fund[];
  fees: FeeSchedule;
  participants: number;
  assetsUsd: number;
  terminatedEffective?: string;
  successorProvider?: string;
  version: number;
  updatedAt: string;
}

interface IdempotencyRecord {
  id: string;
  planId: string;
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) });

export class MockTracStore {
  private plans: Collection<TracPlan>;
  private keys: Collection<IdempotencyRecord>;
  private clock: Clock;
  private failures = 0;
  private failureStatus = 503;

  constructor(db: DatabaseSync, clock: Clock) {
    this.plans = new Collection<TracPlan>(db, 'trac_plans');
    this.keys = new Collection<IdempotencyRecord>(db, 'trac_idempotency');
    this.clock = clock;
  }

  /** Simulate an outage: the next `count` requests fail with `status`. */
  failNext(count: number, status = 503): void {
    this.failures = count;
    this.failureStatus = status;
  }

  getPlan(id: string): TracPlan {
    const p = this.plans.get(id);
    if (!p) throw new Error(`TRAC plan ${id} not found`);
    return p;
  }

  listPlans(): TracPlan[] {
    return this.plans.all();
  }

  readonly handler: MockHandler = ({ method, path, headers, body }) => {
    if (this.failures > 0) {
      this.failures--;
      return json(this.failureStatus, { error: 'Service temporarily unavailable' });
    }
    if (path === '/health') return json(200, { status: 'ok' });
    if (!headers['x-api-key']) return json(401, { error: 'Missing API key' });

    const now = this.clock.now().toISOString();
    const b = (body ?? {}) as Record<string, unknown>;
    const key = headers['idempotency-key'];
    const replay = key ? this.keys.get(key) : undefined;
    if (replay && method !== 'GET') return json(200, this.plans.get(replay.planId));
    const remember = (planId: string) => key && this.keys.insert({ id: key, planId });

    if (path === '/plans' && method === 'GET') return json(200, { plans: this.plans.all() });

    if (path === '/plans' && method === 'POST') {
      const sponsor = b.sponsor as TracPlan['sponsor'] | undefined;
      if (!sponsor?.ein || !sponsor.name) return json(422, { error: 'sponsor.name and sponsor.ein are required' });
      const dup = this.plans.find((p) => p.sponsor.ein === sponsor.ein && p.status === 'ACTIVE');
      if (dup.length) return json(409, { error: `Active plan ${dup[0].id} already exists for EIN ${sponsor.ein}` });
      const plan: TracPlan = {
        id: `TRAC-${String(this.plans.all().length + 100001)}`,
        externalRef: String(b.externalRef ?? ''),
        sponsor,
        planType: String(b.planType ?? ''),
        effectiveDate: String(b.effectiveDate ?? ''),
        status: 'ACTIVE',
        contacts: (b.contacts ?? []) as Contact[],
        funds: (b.funds ?? []) as Fund[],
        fees: b.fees as FeeSchedule,
        participants: Number(b.participants ?? 0),
        assetsUsd: Number(b.assetsUsd ?? 0),
        version: 1,
        updatedAt: now,
      };
      this.plans.insert(plan);
      remember(plan.id);
      return json(201, plan);
    }

    const m = path.match(/^\/plans\/([^/]+)(\/terminate)?$/);
    if (!m) return json(404, { error: `No route ${method} ${path}` });
    const plan = this.plans.get(decodeURIComponent(m[1]));
    if (!plan) return json(404, { error: `Plan ${m[1]} not found` });

    if (!m[2] && method === 'GET') return json(200, plan);
    if (plan.status !== 'ACTIVE') return json(409, { error: `Plan ${plan.id} is ${plan.status}` });

    if (!m[2] && method === 'PATCH') {
      const patch: Partial<TracPlan> = {};
      for (const k of ['contacts', 'funds', 'fees'] as const) if (b[k] !== undefined) Object.assign(patch, { [k]: b[k] });
      const next = { ...plan, ...patch, version: plan.version + 1, updatedAt: now };
      this.plans.update(next);
      remember(plan.id);
      return json(200, next);
    }
    if (m[2] && method === 'POST') {
      const next: TracPlan = { ...plan, status: 'TERMINATED', terminatedEffective: String(b.effectiveDate), successorProvider: String(b.successorProvider), version: plan.version + 1, updatedAt: now };
      this.plans.update(next);
      remember(plan.id);
      return json(200, next);
    }
    return json(405, { error: `${method} not allowed on ${path}` });
  };
}

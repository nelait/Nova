import type { Contact, FeeSchedule, Fund, Plan } from '../domain/types.ts';
import type { Clock } from '../domain/util.ts';
import { Collection, NotFoundError } from '../store/db.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface RecordkeeperPlan {
  id: string; // recordkeeper plan id
  hubPlanId: string;
  sponsorName: string;
  ein: string;
  planType: string;
  effectiveDate: string;
  status: 'ACTIVE' | 'TERMINATED';
  contacts: Contact[];
  funds: Fund[];
  fees: FeeSchedule;
  participantCount: number;
  planAssetsUsd: number;
  terminatedEffective?: string;
  successorProvider?: string;
  version: number;
  updatedAt: string;
}

export type RecordkeeperPatch = Partial<Pick<RecordkeeperPlan, 'contacts' | 'funds' | 'fees'>>;

/**
 * Port to the recordkeeping system of record (e.g. TRAC). Every write carries an
 * idempotency key (case id + step id) so a retried step never double-posts.
 */
export interface RecordkeeperAdapter {
  readonly name: string;
  installPlan(plan: Plan, idempotencyKey: string): RecordkeeperPlan;
  updatePlan(rkPlanId: string, patch: RecordkeeperPatch, idempotencyKey: string): RecordkeeperPlan;
  terminatePlan(rkPlanId: string, info: { effectiveDate: string; successorProvider: string }, idempotencyKey: string): RecordkeeperPlan;
  getPlan(rkPlanId: string): RecordkeeperPlan;
  listPlans(): RecordkeeperPlan[];
}

interface IdempotencyRecord {
  id: string;
  rkPlanId: string;
}

/** In-process stand-in for TRAC, persisted in the same SQLite file. */
export class MockTracAdapter implements RecordkeeperAdapter {
  readonly name = 'TRAC (mock)';
  private plans: Collection<RecordkeeperPlan>;
  private keys: Collection<IdempotencyRecord>;
  private clock: Clock;
  /** Test hook: make the next write fail with this message (simulates an outage). */
  failNextWith?: string;

  constructor(db: DatabaseSync, clock: Clock) {
    this.plans = new Collection<RecordkeeperPlan>(db, 'trac_plans');
    this.keys = new Collection<IdempotencyRecord>(db, 'trac_idempotency');
    this.clock = clock;
  }

  private guard(key: string): RecordkeeperPlan | undefined {
    if (this.failNextWith) {
      const msg = this.failNextWith;
      this.failNextWith = undefined;
      throw new Error(`TRAC unavailable: ${msg}`);
    }
    const prior = this.keys.get(key);
    return prior ? this.plans.get(prior.rkPlanId) : undefined;
  }

  installPlan(plan: Plan, key: string): RecordkeeperPlan {
    const replay = this.guard(key);
    if (replay) return replay;
    const existing = this.plans.find((p) => p.ein === plan.details.ein && p.status === 'ACTIVE');
    if (existing.length) throw new Error(`TRAC rejected install: active plan ${existing[0].id} already exists for EIN ${plan.details.ein}`);
    const rk: RecordkeeperPlan = {
      id: `TRAC-${String(this.plans.all().length + 100001)}`,
      hubPlanId: plan.id,
      sponsorName: plan.details.sponsorName,
      ein: plan.details.ein,
      planType: plan.details.planType,
      effectiveDate: plan.details.effectiveDate,
      status: 'ACTIVE',
      contacts: plan.details.contacts,
      funds: plan.details.funds,
      fees: plan.details.fees,
      participantCount: plan.details.employeeCount,
      planAssetsUsd: plan.details.planAssetsUsd ?? 0,
      version: 1,
      updatedAt: this.clock.now().toISOString(),
    };
    this.plans.insert(rk);
    this.keys.insert({ id: key, rkPlanId: rk.id });
    return rk;
  }

  updatePlan(rkPlanId: string, patch: RecordkeeperPatch, key: string): RecordkeeperPlan {
    const replay = this.guard(key);
    if (replay) return replay;
    const rk = this.getPlan(rkPlanId);
    if (rk.status !== 'ACTIVE') throw new Error(`TRAC rejected update: plan ${rkPlanId} is ${rk.status}`);
    const next = { ...rk, ...patch, version: rk.version + 1, updatedAt: this.clock.now().toISOString() };
    this.plans.update(next);
    this.keys.insert({ id: key, rkPlanId });
    return next;
  }

  terminatePlan(rkPlanId: string, info: { effectiveDate: string; successorProvider: string }, key: string): RecordkeeperPlan {
    const replay = this.guard(key);
    if (replay) return replay;
    const rk = this.getPlan(rkPlanId);
    const next: RecordkeeperPlan = {
      ...rk,
      status: 'TERMINATED',
      terminatedEffective: info.effectiveDate,
      successorProvider: info.successorProvider,
      version: rk.version + 1,
      updatedAt: this.clock.now().toISOString(),
    };
    this.plans.update(next);
    this.keys.insert({ id: key, rkPlanId });
    return next;
  }

  getPlan(rkPlanId: string): RecordkeeperPlan {
    const rk = this.plans.get(rkPlanId);
    if (!rk) throw new NotFoundError(`TRAC plan ${rkPlanId} not found`);
    return rk;
  }

  listPlans(): RecordkeeperPlan[] {
    return this.plans.all();
  }
}

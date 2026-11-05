import type { Fund, Plan, PlanDetails } from '../domain/types.ts';

/** Business validation rule sets used by the `compliance.check` action. Returns a list of issues. */
export type RuleSet = (plan: Plan, request: Record<string, unknown>, today: Date) => string[];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fundIssues(funds: Fund[] | undefined): string[] {
  const issues: string[] = [];
  if (!funds || funds.length === 0) return ['Fund lineup is empty'];
  const qdia = funds.filter((f) => f.qdia).length;
  if (qdia !== 1) issues.push(`Fund lineup must have exactly one QDIA (found ${qdia})`);
  const tickers = funds.map((f) => f.ticker);
  if (new Set(tickers).size !== tickers.length) issues.push('Fund lineup has duplicate tickers');
  return issues;
}

function daysBetween(fromIso: string | Date, toIso: string): number {
  const from = typeof fromIso === 'string' ? new Date(fromIso) : fromIso;
  return Math.floor((new Date(toIso).getTime() - from.getTime()) / 86_400_000);
}

function installation(d: PlanDetails): string[] {
  const issues: string[] = [];
  if (!d.sponsorName) issues.push('Sponsor name is missing');
  if (!/^\d{2}-\d{7}$/.test(d.ein)) issues.push(`EIN "${d.ein}" is not in NN-NNNNNNN format`);
  if (!(d.employeeCount > 0)) issues.push('Employee count must be greater than 0');
  if (!ISO_DATE.test(d.effectiveDate)) issues.push('Effective date missing or not YYYY-MM-DD');
  const admin = d.contacts.find((c) => c.role === 'PLAN_ADMINISTRATOR');
  if (!admin) issues.push('No plan administrator contact');
  else if (!EMAIL.test(admin.email)) issues.push('Plan administrator email is invalid');
  issues.push(...fundIssues(d.funds));
  if (!d.fees || d.fees.recordkeepingBps === undefined) issues.push('Fee schedule missing');
  return issues;
}

export const RULESETS: Record<string, RuleSet> = {
  installation: (plan) => installation(plan.details),

  'contact-change': (_plan, req) => {
    const c = req.contact as { role?: string; name?: string; email?: string } | undefined;
    if (!c) return ['Request has no contact'];
    const issues: string[] = [];
    if (!['PLAN_ADMINISTRATOR', 'PAYROLL', 'TRUSTEE', 'HR'].includes(c.role ?? '')) issues.push(`Unknown contact role "${c.role}"`);
    if (!c.name) issues.push('Contact name missing');
    if (!EMAIL.test(c.email ?? '')) issues.push('Contact email invalid');
    return issues;
  },

  'fund-change': (_plan, req, today) => {
    const issues = fundIssues(req.funds as Fund[] | undefined);
    const eff = String(req.effectiveDate ?? '');
    if (!ISO_DATE.test(eff)) issues.push('Effective date missing or not YYYY-MM-DD');
    else if (daysBetween(today, eff) < 30) issues.push('Effective date is less than 30 days away; the required participant notice cannot be given in time');
    return issues;
  },

  'fee-change': (_plan, req) => {
    const f = req.fees as Record<string, unknown> | undefined;
    if (!f) return ['Request has no fee schedule'];
    return ['recordkeepingBps', 'perParticipantUsd', 'terminationBaseUsd']
      .filter((k) => typeof f[k] !== 'number' || (f[k] as number) < 0)
      .map((k) => `Fee "${k}" missing or negative`);
  },

  termination: (_plan, req, today) => {
    const issues: string[] = [];
    if (!req.reason) issues.push('Termination reason missing');
    if (!req.successorProvider) issues.push('Successor provider missing');
    const eff = String(req.effectiveDate ?? '');
    if (!ISO_DATE.test(eff)) issues.push('Effective date missing or not YYYY-MM-DD');
    else if (daysBetween(today, eff) < 30) issues.push('Effective date is less than 30 days away; the 30-day blackout notice cannot be met');
    if (req.blackoutStart && req.blackoutEnd && String(req.blackoutEnd) < String(req.blackoutStart)) issues.push('Blackout end is before blackout start');
    return issues;
  },
};

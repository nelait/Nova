// Core domain model for the plan operations hub.
// The hub is an intermediary: it orchestrates work and then commits the result
// to the recordkeeper (TRAC), which stays the system of record.

export type CaseType =
  | 'INSTALLATION'
  | 'MAINTENANCE_CONTACT'
  | 'MAINTENANCE_FUNDS'
  | 'MAINTENANCE_FEES'
  | 'TERMINATION';

export type Channel = 'DIGITAL' | 'PAPER' | 'MANUAL';

/** How much a human is involved in a step. Decided per step, overridable per client. */
export type Mode = 'AUTO' | 'REVIEW' | 'MANUAL';

export type TaskStatus = 'BLOCKED' | 'READY' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED';
export type CaseStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';
export type PlanStatus = 'ONBOARDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED';

export type ContactRole = 'PLAN_ADMINISTRATOR' | 'PAYROLL' | 'TRUSTEE' | 'HR';

export interface Contact {
  role: ContactRole;
  name: string;
  email: string;
  phone?: string;
}

export interface Fund {
  ticker: string;
  name: string;
  qdia?: boolean; // Qualified Default Investment Alternative
}

export interface FeeSchedule {
  recordkeepingBps: number; // asset-based fee, basis points per year
  perParticipantUsd: number; // annual per-participant fee
  terminationBaseUsd: number; // flat fee charged on deconversion
}

export interface PlanDetails {
  sponsorName: string;
  ein: string;
  employeeCount: number;
  planType: '401K' | '403B' | '457B';
  effectiveDate: string; // ISO date
  planAssetsUsd?: number;
  contacts: Contact[];
  funds: Fund[];
  fees: FeeSchedule;
}

export interface Plan {
  id: string;
  clientId: string;
  status: PlanStatus;
  details: PlanDetails;
  tracPlanId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Case {
  id: string;
  planId: string;
  clientId: string;
  type: CaseType;
  channel: Channel;
  status: CaseStatus;
  /** Type-specific request data (e.g. new contact, new fund lineup, termination info). */
  request: Record<string, unknown>;
  playbookId: string;
  playbookVersion: number;
  createdAt: string;
  completedAt?: string;
}

export type ActionType =
  | 'rules.evaluate'
  | 'integration.call'
  | 'contacts.upsert'
  | 'funds.apply'
  | 'fees.apply'
  | 'email.send'
  | 'trac.installPlan'
  | 'trac.updatePlan'
  | 'trac.terminatePlan'
  | 'none';

export interface ActionSpec {
  type: ActionType;
  params?: Record<string, unknown>;
}

export interface PlaybookStep {
  id: string;
  name: string;
  skill: string;
  minSkillLevel?: number;
  mode: Mode;
  action: ActionSpec;
  dependsOn?: string[];
  /**
   * Optional condition (rule expression). When it is false once the step's
   * dependencies are done, the step is skipped. Can read plan, request, case,
   * steps (earlier results), today and client.
   */
  when?: string;
  slaHours?: number;
  guidance: string;
  checklist?: string[];
  regulatoryRef?: string;
}

export interface Playbook {
  id: string;
  version: number;
  caseType: CaseType;
  name: string;
  description: string;
  steps: PlaybookStep[];
}

export interface TaskEvent {
  at: string;
  by: string; // user id or 'system'
  event: string;
  detail?: unknown;
}

export interface Task {
  id: string;
  caseId: string;
  planId: string;
  stepId: string;
  name: string;
  skill: string;
  minSkillLevel: number;
  mode: Mode;
  action: ActionSpec;
  dependsOn: string[];
  status: TaskStatus;
  assigneeId?: string;
  /** Set when an AUTO step failed and was handed to a human. */
  exception?: string;
  draftEdited?: boolean;
  /** For email steps: whether the sent email started from the template or Claude's draft. */
  draftSource?: 'template' | 'ai';
  result?: unknown;
  createdAt: string;
  readyAt?: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
  history: TaskEvent[];
}

export interface SkillGrant {
  skill: string;
  level: number; // 1 = trainee, 2 = proficient, 3 = expert
}

export interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
  capacity: number; // max concurrent open tasks
  skills: SkillGrant[];
  source: string; // e.g. 'okta', 'azure-ad', 'seed'
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  entity: 'case' | 'task' | 'plan' | 'user';
  entityId: string;
  caseId?: string;
  event: string;
  detail?: unknown;
}

export interface OutboundEmail {
  id: string;
  caseId: string;
  taskId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  sentAt: string;
  sentBy: string;
}

/** Per-client customization layered over the generic playbooks. */
export interface ClientConfig {
  clientId: string;
  displayName: string;
  playbookOverrides?: Partial<
    Record<
      CaseType,
      {
        disableSteps?: string[];
        modeOverrides?: Record<string, Mode>;
        addSteps?: PlaybookStep[];
      }
    >
  >;
  templateOverrides?: Record<string, string>; // template name -> template file in config/templates
  ruleSetOverrides?: Record<string, string>; // rule set id -> client-specific rule set id
}

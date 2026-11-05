import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseType, ClientConfig, Playbook, PlaybookStep } from '../domain/types.ts';
import { ValidationError } from '../store/db.ts';
import { RuleRegistry, STEP_CONDITION_ROOTS } from '../rules/ruleEngine.ts';
import { compile } from '../rules/expression.ts';
import { IntegrationRegistry, compileBody } from '../integrations/registry.ts';
import { AgentRegistry } from '../ai/agents.ts';

export interface EmailTemplate {
  name: string;
  subject: string;
  body: string;
}

/**
 * Knowledge base: the versioned process definitions (playbooks), the communication
 * templates, and the per-client customizations layered on top.
 *
 * Playbooks decide WHAT must happen (deterministic, auditable). The guidance layer
 * only explains and pre-fills; it never adds or drops compliance steps.
 */
export class KnowledgeBase {
  private playbooks = new Map<CaseType, Playbook>();
  private templates = new Map<string, EmailTemplate>();
  private clients = new Map<string, ClientConfig>();
  readonly rules: RuleRegistry;
  readonly integrations: IntegrationRegistry;
  readonly agents: AgentRegistry;

  constructor(configDir: string, env: Record<string, string | undefined> = process.env) {
    this.rules = new RuleRegistry(join(configDir, 'rules'));
    this.integrations = new IntegrationRegistry(join(configDir, 'integrations'), env);
    this.agents = new AgentRegistry(join(configDir, 'agents'), this.integrations);
    for (const f of readdirSync(join(configDir, 'playbooks')).filter((f) => f.endsWith('.json'))) {
      const pb = JSON.parse(readFileSync(join(configDir, 'playbooks', f), 'utf8')) as Playbook;
      validatePlaybook(pb, this.rules, this.integrations, this.agents);
      this.playbooks.set(pb.caseType, pb);
    }
    for (const f of readdirSync(join(configDir, 'templates')).filter((f) => f.endsWith('.txt'))) {
      const raw = readFileSync(join(configDir, 'templates', f), 'utf8');
      const [first, ...rest] = raw.split('\n');
      const subject = first.replace(/^Subject:\s*/, '');
      this.templates.set(f.replace(/\.txt$/, ''), { name: f.replace(/\.txt$/, ''), subject, body: rest.join('\n').trim() });
    }
    const clientsDir = join(configDir, 'clients');
    if (existsSync(clientsDir)) {
      for (const f of readdirSync(clientsDir).filter((f) => f.endsWith('.json'))) {
        const c = JSON.parse(readFileSync(join(clientsDir, f), 'utf8')) as ClientConfig;
        this.clients.set(c.clientId, c);
      }
    }
    // Check every client's customized playbooks and rule set overrides at startup.
    for (const c of this.clients.values()) {
      for (const [from, to] of Object.entries(c.ruleSetOverrides ?? {})) {
        if (!this.rules.has(from) || !this.rules.has(to)) throw new ValidationError(`Client ${c.clientId}: rule set override ${from} -> ${to} names an unknown rule set`);
      }
      for (const t of this.playbooks.keys()) this.playbookFor(t, c.clientId);
    }
  }

  /** The rule set a client actually uses (client overrides replace the generic one). */
  ruleSetFor(ruleSetId: string, clientId: string): string {
    return this.client(clientId).ruleSetOverrides?.[ruleSetId] ?? ruleSetId;
  }

  listPlaybooks(): Playbook[] {
    return [...this.playbooks.values()];
  }

  listClients(): ClientConfig[] {
    return [...this.clients.values()].sort((a, b) => (a.clientId === 'default' ? -1 : b.clientId === 'default' ? 1 : a.clientId.localeCompare(b.clientId)));
  }

  client(clientId: string): ClientConfig {
    return this.clients.get(clientId) ?? { clientId, displayName: clientId };
  }

  /** The generic playbook for a case type with the client's overrides applied. */
  playbookFor(caseType: CaseType, clientId: string): Playbook {
    const base = this.playbooks.get(caseType);
    if (!base) throw new ValidationError(`No playbook for case type ${caseType}`);
    const ov = this.client(clientId).playbookOverrides?.[caseType];
    if (!ov) return base;

    const disabled = new Set(ov.disableSteps ?? []);
    let steps: PlaybookStep[] = base.steps
      .filter((s) => !disabled.has(s.id))
      .map((s) => ({
        ...s,
        mode: ov.modeOverrides?.[s.id] ?? s.mode,
        dependsOn: (s.dependsOn ?? []).filter((d) => !disabled.has(d)),
      }));
    steps = steps.concat(ov.addSteps ?? []);
    const pb: Playbook = { ...base, id: `${base.id}+${clientId}`, steps };
    validatePlaybook(pb, this.rules, this.integrations, this.agents);
    return pb;
  }

  template(name: string, clientId: string): EmailTemplate {
    const override = this.client(clientId).templateOverrides?.[name];
    const t = this.templates.get(override ?? name);
    if (!t) throw new ValidationError(`Template ${override ?? name} not found`);
    return t;
  }
}

/**
 * Steps must have unique ids, known dependencies and no cycles. Rule steps must
 * name a known rule set, and step conditions must compile.
 */
export function validatePlaybook(pb: Playbook, rules?: RuleRegistry, integrations?: IntegrationRegistry, agents?: AgentRegistry): void {
  const ids = new Set<string>();
  for (const s of pb.steps) {
    if (ids.has(s.id)) throw new ValidationError(`Playbook ${pb.id}: duplicate step ${s.id}`);
    ids.add(s.id);
  }
  for (const s of pb.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!ids.has(d)) throw new ValidationError(`Playbook ${pb.id}: step ${s.id} depends on unknown step ${d}`);
    }
    if (s.when) {
      try {
        compile(s.when, STEP_CONDITION_ROOTS);
      } catch (e) {
        throw new ValidationError(`Playbook ${pb.id}: step ${s.id} condition: ${(e as Error).message}`);
      }
    }
    if (s.action.type === 'rules.evaluate') {
      const id = String(s.action.params?.ruleSet ?? '');
      if (rules && !rules.has(id)) throw new ValidationError(`Playbook ${pb.id}: step ${s.id} uses unknown rule set "${id}"`);
    }
    if (s.action.type === 'ai.agent') {
      const id = String(s.action.params?.agent ?? '');
      if (agents && !agents.has(id)) throw new ValidationError(`Playbook ${pb.id}: step ${s.id} uses unknown agent "${id}"`);
      // AI output is always a proposal that a person approves.
      if (s.mode !== 'REVIEW') throw new ValidationError(`Playbook ${pb.id}: step ${s.id} runs an AI agent, so its mode must be REVIEW`);
    }
    if (s.action.type === 'integration.call') {
      const sys = String(s.action.params?.system ?? '');
      const op = String(s.action.params?.operation ?? '');
      if (integrations && !integrations.has(sys, op)) throw new ValidationError(`Playbook ${pb.id}: step ${s.id} calls unknown integration operation "${sys}.${op}"`);
      try {
        compileBody(s.action.params?.input ?? {}, STEP_CONDITION_ROOTS);
      } catch (e) {
        throw new ValidationError(`Playbook ${pb.id}: step ${s.id} input: ${(e as Error).message}`);
      }
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(pb.steps.map((s) => [s.id, s]));
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new ValidationError(`Playbook ${pb.id}: dependency cycle at ${id}`);
    visiting.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
    visiting.delete(id);
    done.add(id);
  };
  pb.steps.forEach((s) => visit(s.id));
}

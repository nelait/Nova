import { readFileSync } from 'node:fs';
import type { User } from '../domain/types.ts';

/**
 * Permissions and roles.
 *
 * A permission is one kind of action. A role is a named bundle of permissions,
 * defined in config/roles.json, and given to people with identity-provider
 * groups named `role:<name>` (or `roles` in a direct import). What a person may
 * do is the union of the default roles (everyone) and their own roles.
 *
 * What *work* a person gets is still decided by skills and levels: `tasks.work`
 * only says whether they can be given tasks at all.
 *
 * A role marked `readOnly` (the auditor) removes every permission that changes
 * something, whatever other roles the person has: adding a group can't quietly
 * give an audit account write access.
 */
export const PERMISSIONS = {
  'cases.start': 'Start requests: installations, maintenance and terminations (New request)',
  'tasks.work': 'Be routed tasks and work your own: complete, ask Claude, run agents, hand back to routing',
  'tasks.override': 'Override a failed automatic step on your own task, with a justification',
  'tasks.reassign': "Reassign anyone's task",
  'cases.cancel': 'Cancel an open case',
  'plans.edit': "Edit a plan's details directly, outside a case",
  'users.manage': 'Import users from the identity provider; activate and deactivate users',
  'integrations.test': "Test an integration's connection (calls the external system)",
  'audit.read': 'See and download the full audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions that only read. A read-only role keeps these and loses the rest. */
const READ_PERMISSIONS: ReadonlySet<Permission> = new Set(['audit.read']);

export interface RoleDef {
  description: string;
  /** Permission names, or "*" for all of them. */
  permissions: string[];
  readOnly?: boolean;
}

export interface RolesConfig {
  /** Roles everyone has, before their own (normally "specialist"). */
  defaultRoles: string[];
  roles: Record<string, RoleDef>;
}

const ALL = Object.keys(PERMISSIONS) as Permission[];

export class RoleModel {
  readonly config: RolesConfig;

  constructor(config: RolesConfig) {
    const problems: string[] = [];
    for (const [name, r] of Object.entries(config.roles ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`role "${name}": names are lowercase letters, digits and dashes (they come from groups named role:<name>)`);
      if (!r.description?.trim()) problems.push(`role "${name}": needs a description`);
      if (!Array.isArray(r.permissions)) problems.push(`role "${name}": permissions must be a list`);
      for (const p of r.permissions ?? []) if (p !== '*' && !(p in PERMISSIONS)) problems.push(`role "${name}": unknown permission "${p}". Known: ${ALL.join(', ')}`);
    }
    for (const d of config.defaultRoles ?? []) if (!config.roles?.[d]) problems.push(`defaultRoles: no role named "${d}"`);
    if (problems.length) throw new Error(`config/roles.json is invalid:\n- ${problems.join('\n- ')}`);
    this.config = config;
  }

  static load(path: string): RoleModel {
    return new RoleModel(JSON.parse(readFileSync(path, 'utf8')) as RolesConfig);
  }

  /** The person's roles that exist in config (unknown group names are ignored). */
  rolesOf(u: User | undefined): string[] {
    if (!u) return [];
    return [...new Set([...this.config.defaultRoles, ...(u.roles ?? [])])].filter((r) => this.config.roles[r]);
  }

  isReadOnly(u: User | undefined): boolean {
    return this.rolesOf(u).some((r) => this.config.roles[r].readOnly);
  }

  permissions(u: User | undefined): Permission[] {
    if (!u?.active) return [];
    const granted = new Set<Permission>();
    for (const r of this.rolesOf(u)) {
      const ps = this.config.roles[r].permissions;
      for (const p of ps.includes('*') ? ALL : (ps as Permission[])) granted.add(p);
    }
    const readOnly = this.isReadOnly(u);
    return ALL.filter((p) => granted.has(p) && (!readOnly || READ_PERMISSIONS.has(p)));
  }

  can(u: User | undefined, p: Permission): boolean {
    return this.permissions(u).includes(p);
  }

  /** Can this person be given tasks? */
  canWork(u: User): boolean {
    return u.active && this.can(u, 'tasks.work');
  }
}

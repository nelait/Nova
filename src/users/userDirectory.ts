import type { SkillGrant, User } from '../domain/types.ts';
import type { Collection } from '../store/db.ts';
import { ValidationError } from '../store/db.ts';

/** Minimal SCIM 2.0 user shape, as sent by Okta / Entra ID / Ping provisioning. */
export interface ScimUser {
  id?: string;
  userName: string;
  displayName?: string;
  active?: boolean;
  emails?: { value: string; primary?: boolean }[];
  groups?: { display: string }[];
}

/**
 * Users come from an external identity provider. Skills are carried as IdP groups
 * named `skill:<SKILL>:<level>` (e.g. `skill:COMPLIANCE:3`) so skill administration
 * stays in the IdP; capacity is a local setting.
 */
export function scimToUser(s: ScimUser, source: string, capacity = 8): User {
  const skills: SkillGrant[] = [];
  const roles: string[] = [];
  for (const g of s.groups ?? []) {
    const m = g.display.match(/^skill:([A-Z_]+):([1-3])$/);
    if (m) skills.push({ skill: m[1], level: Number(m[2]) });
    const r = g.display.match(/^role:([a-z][a-z0-9-]*)$/);
    if (r) roles.push(r[1]);
  }
  const email = s.emails?.find((e) => e.primary)?.value ?? s.emails?.[0]?.value ?? s.userName;
  return {
    id: s.id ? `u_${s.id}` : `u_${s.userName.replace(/[^a-zA-Z0-9]/g, '_')}`,
    name: s.displayName ?? s.userName,
    email,
    active: s.active ?? true,
    capacity,
    skills,
    roles,
    source,
  };
}

export class UserDirectory {
  private users: Collection<User>;

  constructor(users: Collection<User>) {
    this.users = users;
  }

  /**
   * Upserts the given users. With fullSync, users from the same source that are
   * not in the batch are deactivated (they left the IdP).
   */
  import(batch: Partial<User>[], source: string, fullSync = false): User[] {
    const seen = new Set<string>();
    const out: User[] = [];
    for (const u of batch) {
      if (!u.id || !u.name) throw new ValidationError('Each user needs id and name');
      const existing = this.users.get(u.id);
      const user: User = {
        id: u.id,
        name: u.name,
        email: u.email ?? existing?.email ?? '',
        active: u.active ?? true,
        capacity: u.capacity ?? existing?.capacity ?? 8,
        skills: u.skills ?? existing?.skills ?? [],
        roles: u.roles ?? existing?.roles ?? [],
        source,
      };
      this.users.upsert(user);
      seen.add(user.id);
      out.push(user);
    }
    if (fullSync) {
      for (const u of this.users.find((x) => x.source === source && !seen.has(x.id) && x.active)) {
        this.users.update({ ...u, active: false });
      }
    }
    return out;
  }

  importScim(batch: ScimUser[], source: string, fullSync = false): User[] {
    return this.import(batch.map((s) => scimToUser(s, source)), source, fullSync);
  }

  setActive(id: string, active: boolean): User {
    const u = this.users.require(id);
    return this.users.update({ ...u, active });
  }

  list(): User[] {
    return this.users.all();
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  /** User with this email (case-insensitive), active or not; sign-in checks `active` itself. */
  byEmail(email: string): User | undefined {
    const e = email.trim().toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === e)[0];
  }
}

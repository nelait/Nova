import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal document store on top of node:sqlite. Each collection is a table of
 * (id, json). Good enough for a prototype; swap for Postgres + real tables later
 * without touching the services (they only use this interface).
 */
export class Collection<T extends { id: string }> {
  private db: DatabaseSync;
  private name: string;

  constructor(db: DatabaseSync, name: string) {
    this.db = db;
    this.name = name;
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, seq INTEGER, data TEXT NOT NULL)`);
  }

  insert(doc: T): T {
    this.db
      .prepare(`INSERT INTO ${this.name} (id, seq, data) VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM ${this.name}), ?)`)
      .run(doc.id, JSON.stringify(doc));
    return doc;
  }

  update(doc: T): T {
    const r = this.db.prepare(`UPDATE ${this.name} SET data = ? WHERE id = ?`).run(JSON.stringify(doc), doc.id);
    if (r.changes === 0) throw new Error(`${this.name}/${doc.id} not found`);
    return doc;
  }

  upsert(doc: T): T {
    return this.get(doc.id) ? this.update(doc) : this.insert(doc);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.name} WHERE id = ?`).run(id).changes > 0;
  }

  get(id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${this.name} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  require(id: string): T {
    const doc = this.get(id);
    if (!doc) throw new NotFoundError(`${this.name}/${id} not found`);
    return doc;
  }

  all(): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${this.name} ORDER BY seq`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  find(pred: (doc: T) => boolean): T[] {
    return this.all().filter(pred);
  }
}

export class NotFoundError extends Error {}
export class ValidationError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

export function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

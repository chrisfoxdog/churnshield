import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { nowIso, type SaveTaskKind, type SaveTaskStatus, type StoredRisk } from './constants.js';

// ---------------------------------------------------------------------------
// Entity types. Every tenant table carries creator_id. Member records are
// keyed by (creator_id, whop_membership_id) with whop_user_id stored — the
// real Whop v1 payload carries no member name or email, so display_name
// falls back to "Member" and is only ever upgraded if a payload provides one.
// ---------------------------------------------------------------------------

export interface Creator {
  id: string;
  whop_company_id: string;
  whop_user_id: string; // '' until the owner first opens the app (see server.ts identity resolution)
  display_name: string;
  silent_threshold_days: number; // default 14 — drives the silent-member radar
  created_at: string;
  updated_at: string;
}

export type MemberStatus = 'active' | 'churned';

export interface Member {
  id: string;
  creator_id: string;
  whop_user_id: string;
  whop_membership_id: string; // '' only if an event ever arrives without one
  display_name: string; // 'Member' unless a payload provided a name
  product_id: string;
  product_title: string; // '' when the payload carried no product
  plan_id: string; // the Whop variant_id — v1 payloads have no plan name
  plan_amount: number | null; // dollars, exactly as Whop reported; null when unknown — never invented
  plan_currency: string; // 'USD' unless a payload said otherwise
  status: MemberStatus;
  risks: StoredRisk[]; // event-driven risks only; 'silent' is derived at read
  first_seen_at: string;
  last_event_at: string;
  last_event_type: string;
  churned_at?: string;
  created_via_event_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SaveTask {
  id: string;
  creator_id: string;
  member_id: string;
  whop_membership_id: string;
  kind: SaveTaskKind;
  status: SaveTaskStatus;
  amount: number | null; // snapshot of the member's plan amount when the task opened
  currency: string;
  opened_via_event_id?: string;
  closed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow {
  id: string;
  whop_event_id: string; // the envelope message id (msg_…) — dedupe key
  type: string;
  received_at: string;
  processed_at?: string;
  result: 'processed' | 'ignored-duplicate' | 'ignored' | 'error';
  payload_min: Record<string, unknown>; // minimized: IDs and statuses only
  created_at: string;
}

export interface AuditEntry {
  id: string;
  actor: 'creator' | 'system';
  action: string; // creator_sign_in | task_saved | task_lost
  creator_id?: string;
  member_id?: string;
  detail?: string;
  created_at: string;
}

export const TABLES = ['creators', 'members', 'save_tasks', 'webhook_events', 'audit_log'] as const;

export type TableName = (typeof TABLES)[number];

export type Row = Record<string, any>;

export interface StoreData {
  creators: Record<string, Creator>;
  members: Record<string, Member>;
  save_tasks: Record<string, SaveTask>;
  webhook_events: Record<string, WebhookEventRow>;
  audit_log: Record<string, AuditEntry>;
}

export function emptyStore(): StoreData {
  return { creators: {}, members: {}, save_tasks: {}, webhook_events: {}, audit_log: {} };
}

export interface IDatabase {
  getAll<T = Row>(table: TableName): Promise<T[]>;
  getById<T = Row>(table: TableName, id: string): Promise<T | undefined>;
  insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T>;
  update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined>;
  remove(table: TableName, id: string): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; type: 'postgres' | 'file'; details?: string }>;
  withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// File-backed store (local development only — production requires Postgres)
// ---------------------------------------------------------------------------

export class FileDatabase implements IDatabase {
  private filePath: string;
  private data: StoreData;

  constructor(filePath?: string) {
    const dir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.filePath = filePath || process.env.CHURNSHIELD_STORE_PATH || path.resolve(dir, 'store.json');
    const parent = path.dirname(this.filePath);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        const base = emptyStore();
        for (const t of TABLES) {
          if (parsed[t] && typeof parsed[t] === 'object') (base as any)[t] = parsed[t];
        }
        return base;
      }
    } catch (err) {
      console.error('Error loading store.json, using clean memory store:', err);
    }
    return emptyStore();
  }

  private save() {
    try {
      const tempPath = `${this.filePath}.tmp.${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('Failed to atomically write store.json:', err);
    }
  }

  async getAll<T = Row>(table: TableName): Promise<T[]> {
    return Object.values((this.data as any)[table]) as T[];
  }

  async getById<T = Row>(table: TableName, id: string): Promise<T | undefined> {
    const row = (this.data as any)[table][id];
    return row ? ({ ...row } as T) : undefined;
  }

  async insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T> {
    (this.data as any)[table][row.id] = { ...row };
    this.save();
    return { ...row };
  }

  async update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const current = (this.data as any)[table][id];
    if (!current) return undefined;
    const updated = { ...current, ...updates, updated_at: (updates as any).updated_at || nowIso() };
    (this.data as any)[table][id] = updated;
    this.save();
    return { ...updated };
  }

  async remove(table: TableName, id: string): Promise<boolean> {
    if (!(this.data as any)[table][id]) return false;
    delete (this.data as any)[table][id];
    this.save();
    return true;
  }

  async healthCheck() {
    return { ok: true, type: 'file' as const, details: 'Local JSON store (development only)' };
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    const snapshot = JSON.stringify(this.data);
    try {
      const result = await callback(this);
      this.save();
      return result;
    } catch (err) {
      this.data = JSON.parse(snapshot);
      this.save();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres store (production). One generic JSONB table per entity keeps the
// schema exactly in step with the entity types above; creator_id is a real
// column so tenant scoping is enforced in SQL, not just in application code.
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

class PgStore implements IDatabase {
  constructor(private query: QueryFn, private inTransaction = false) {}

  async getAll<T = Row>(table: TableName): Promise<T[]> {
    const res = await this.query(`SELECT data FROM ${table} ORDER BY created_at ASC`);
    return res.rows.map((r) => r.data as T);
  }

  async getById<T = Row>(table: TableName, id: string): Promise<T | undefined> {
    const res = await this.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
    return res.rows[0]?.data as T | undefined;
  }

  async insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T> {
    const r = row as Row;
    await this.query(
      `INSERT INTO ${table} (id, creator_id, data, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, NOW()), COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.creator_id || null, JSON.stringify(r), r.created_at || null, r.updated_at || null]
    );
    return row;
  }

  async update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const current = await this.getById<Row>(table, id);
    if (!current) return undefined;
    const updated = { ...current, ...updates, updated_at: (updates as any).updated_at || nowIso() };
    await this.query(`UPDATE ${table} SET data = $2::jsonb, creator_id = $3, updated_at = $4::timestamptz WHERE id = $1`, [
      id,
      JSON.stringify(updated),
      updated.creator_id || null,
      updated.updated_at,
    ]);
    return updated as T;
  }

  async remove(table: TableName, id: string): Promise<boolean> {
    const res = await this.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return (res as any).rowCount !== 0;
  }

  async healthCheck() {
    try {
      await this.query('SELECT 1');
      return { ok: true, type: 'postgres' as const };
    } catch (err: any) {
      return { ok: false, type: 'postgres' as const, details: err.message };
    }
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    if (this.inTransaction) return callback(this);
    throw new Error('withTransaction must be called on PostgresDatabase, not a bare PgStore');
  }
}

export class PostgresDatabase implements IDatabase {
  private pool: pg.Pool;
  private initialized = false;
  private root: PgStore;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
    this.root = new PgStore((sql, params) => this.pool.query(sql, params as any[]));
  }

  private async init() {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      for (const t of TABLES) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${t} (
            id TEXT PRIMARY KEY,
            creator_id TEXT,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_${t}_creator ON ${t} (creator_id);
        `);
      }
      // Idempotency backstop: an envelope message id can only ever be
      // recorded once, even if two deliveries race.
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_whop_id ON webhook_events ((data->>'whop_event_id'));`);
      this.initialized = true;
    } finally {
      client.release();
    }
  }

  private async ready<T>(fn: (store: PgStore) => Promise<T>): Promise<T> {
    await this.init();
    return fn(this.root);
  }

  getAll<T = Row>(table: TableName) { return this.ready((s) => s.getAll<T>(table)); }
  getById<T = Row>(table: TableName, id: string) { return this.ready((s) => s.getById<T>(table, id)); }
  insert<T = Row>(table: TableName, row: T & { id: string }) { return this.ready((s) => s.insert(table, row)); }
  update<T = Row>(table: TableName, id: string, updates: Partial<T>) { return this.ready((s) => s.update(table, id, updates)); }
  remove(table: TableName, id: string) { return this.ready((s) => s.remove(table, id)); }

  async healthCheck() {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, type: 'postgres' as const };
    } catch (err: any) {
      return { ok: false, type: 'postgres' as const, details: err.message };
    }
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PgStore((sql, params) => client.query(sql, params as any[]), true);
      const result = await callback(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton. Production REQUIRES Postgres — no silent fallback, ever.
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error(
    'FATAL CONFIGURATION ERROR: DATABASE_URL is not set in production. ChurnShield requires a persistent PostgreSQL database in production; the local file store is strictly disabled in production.'
  );
}

export const db: IDatabase = process.env.DATABASE_URL
  ? new PostgresDatabase(process.env.DATABASE_URL)
  : new FileDatabase();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

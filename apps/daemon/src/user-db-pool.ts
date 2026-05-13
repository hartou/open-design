/**
 * Per-user database pool for SaaS mode.
 *
 * Each authenticated Clerk user gets their own SQLite database under
 * `<baseDataDir>/users/<userId>/app.sqlite`. The pool caches open
 * connections and creates user directories on first access.
 *
 * When Cosmos DB is configured (OD_COSMOS_ENDPOINT), on first access for
 * a user, the database is hydrated from Cosmos. A periodic sync loop
 * mirrors local changes back to Cosmos for durability.
 *
 * In non-SaaS mode, the pool is unused — the daemon uses its single
 * shared database as before.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { isCosmosConfigured, hydrateFromCosmos, markDirty } from './cosmos-sync.js';

type SqliteDb = Database.Database;

// Full schema migration matching db.ts — duplicated here to avoid
// circular deps with the main db module's singleton state.
function migrateUserDb(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      pending_prompt TEXT,
      metadata_json TEXT,
      custom_instructions TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_project_id TEXT,
      files_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conv_project
      ON conversations(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      run_id TEXT,
      run_status TEXT,
      last_run_event_id TEXT,
      events_json TEXT,
      attachments_json TEXT,
      comment_attachments_json TEXT,
      produced_files_json TEXT,
      feedback_json TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, position);

    CREATE TABLE IF NOT EXISTS preview_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      element_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      position_json TEXT NOT NULL,
      html_hint TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL,
      selection_kind TEXT,
      member_count INTEGER,
      pod_members_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, conversation_id, file_path, element_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation
      ON preview_comments(project_id, conversation_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tabs (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id, name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tabs_project
      ON tabs(project_id, position);

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      url TEXT NOT NULL,
      deployment_id TEXT,
      deployment_count INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL DEFAULT 'preview',
      status TEXT NOT NULL DEFAULT 'ready',
      status_message TEXT,
      reachable_at INTEGER,
      provider_metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, file_name, provider_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON deployments(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_json TEXT,
      project_mode TEXT NOT NULL,
      project_id TEXT,
      skill_id TEXT,
      agent_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      summary TEXT,
      error TEXT,
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS media_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN
        ('queued','running','done','failed','interrupted')),
      surface TEXT,
      model TEXT,
      progress_json TEXT NOT NULL DEFAULT '[]',
      file_json TEXT,
      error_json TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_tasks_project
      ON media_tasks(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_media_tasks_status
      ON media_tasks(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS critique_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      artifact_path TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('shipped','below_threshold','timed_out','interrupted','degraded','failed','legacy','running')),
      score REAL,
      rounds_json TEXT NOT NULL DEFAULT '[]',
      transcript_path TEXT,
      protocol_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_critique_runs_project
      ON critique_runs(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_critique_runs_status
      ON critique_runs(status);
  `);
}

interface PoolEntry {
  db: SqliteDb;
  dataDir: string;
  lastAccessed: number;
}

const pool = new Map<string, PoolEntry>();

// Evict idle connections after 10 minutes.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Sanitize userId to a filesystem-safe directory name.
 * Clerk user IDs are like `user_2abc123...` — alphanumeric + underscores.
 * We strip anything unexpected to prevent path traversal.
 */
function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Track pending Cosmos hydrations so route handlers can await them.
const pendingHydrations = new Map<string, Promise<void>>();

/**
 * Get or create a per-user database and data directory.
 *
 * When Cosmos DB is configured, the first call for a given user triggers
 * an async hydration from Cosmos (populating the freshly-created SQLite
 * with durable data from the cloud). Subsequent calls return immediately.
 */
export function getUserDb(baseDataDir: string, userId: string): { db: SqliteDb; dataDir: string } {
  const sanitized = sanitizeUserId(userId);
  if (!sanitized) {
    throw new Error('Invalid userId for per-user storage');
  }

  const existing = pool.get(sanitized);
  if (existing) {
    existing.lastAccessed = Date.now();
    return { db: existing.db, dataDir: existing.dataDir };
  }

  const dataDir = path.join(baseDataDir, 'users', sanitized);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'artifacts'), { recursive: true });

  const dbFile = path.join(dataDir, 'app.sqlite');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateUserDb(db);

  const entry: PoolEntry = { db, dataDir, lastAccessed: Date.now() };
  pool.set(sanitized, entry);

  // Kick off Cosmos hydration in the background (fire-and-forget).
  // The hydration populates the empty SQLite with durable user data.
  if (isCosmosConfigured()) {
    const hydration = hydrateFromCosmos(db, userId).then(() => {}).catch((err) => {
      console.error(`[user-db-pool] Cosmos hydration failed for ${sanitized}:`, err);
    }).finally(() => {
      pendingHydrations.delete(sanitized);
    });
    pendingHydrations.set(sanitized, hydration);
  }

  return { db, dataDir };
}

/**
 * Wait for a user's Cosmos hydration to complete (if pending).
 * Route middleware should await this before serving data-dependent requests.
 */
export async function awaitHydration(userId: string): Promise<void> {
  const sanitized = sanitizeUserId(userId);
  const pending = pendingHydrations.get(sanitized);
  if (pending) await pending;
}

/**
 * Close and evict idle database connections.
 * Call this periodically (e.g. every 5 minutes).
 */
export function evictIdleUserDbs(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of pool) {
    if (now - entry.lastAccessed > IDLE_TIMEOUT_MS) {
      try { entry.db.close(); } catch { /* ignore */ }
      pool.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Close all pooled databases (shutdown).
 */
export function closeAllUserDbs(): void {
  for (const [, entry] of pool) {
    try { entry.db.close(); } catch { /* ignore */ }
  }
  pool.clear();
}

// Start idle eviction loop.
const _evictionTimer = setInterval(evictIdleUserDbs, 5 * 60 * 1000);
if (_evictionTimer.unref) _evictionTimer.unref();

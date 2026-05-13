/**
 * Cosmos DB sync layer for SaaS mode.
 *
 * Architecture: SQLite stays the hot-path (synchronous, fast). Cosmos DB
 * is the durable backing store. On first user access, SQLite is hydrated
 * from Cosmos. A periodic sync loop mirrors local writes back to Cosmos.
 *
 * Env vars:
 *   OD_COSMOS_ENDPOINT  — Cosmos account URI
 *   OD_COSMOS_KEY       — Cosmos primary key
 *   OD_COSMOS_DATABASE  — database name (default: "opendesign")
 *   OD_COSMOS_CONTAINER — container name (default: "userdata")
 */

import { CosmosClient, Container, Database as CosmosDatabase } from '@azure/cosmos';
import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

// All tables the daemon uses, with their primary key type.
const TABLES: { name: string; compositeKey?: string[] }[] = [
  { name: 'projects' },
  { name: 'templates' },
  { name: 'conversations' },
  { name: 'messages' },
  { name: 'preview_comments' },
  { name: 'tabs', compositeKey: ['project_id', 'name'] },
  { name: 'deployments' },
  { name: 'routines' },
  { name: 'routine_runs' },
  { name: 'media_tasks' },
  { name: 'critique_runs' },
];

function cosmosDocId(table: string, row: Record<string, any>, compositeKey?: string[]): string {
  if (compositeKey) {
    return `${table}:${compositeKey.map(k => row[k]).join(':')}`;
  }
  return `${table}:${row.id}`;
}

/** Set of userIds that have been hydrated from Cosmos in this process lifetime. */
const hydratedUsers = new Set<string>();

let cosmosClient: CosmosClient | null = null;
let cosmosContainer: Container | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

// Track which user DBs need syncing (dirty set).
const dirtyUsers = new Set<string>();

// Reference to the user-db-pool getter so the sync loop can iterate users.
let userDbGetter: ((userId: string) => { db: SqliteDb; dataDir: string }) | null = null;

/** Check whether Cosmos sync is configured. */
export function isCosmosConfigured(): boolean {
  return !!(process.env.OD_COSMOS_ENDPOINT && process.env.OD_COSMOS_KEY);
}

/** Initialize the Cosmos client and container reference. */
export async function initCosmos(): Promise<void> {
  const endpoint = process.env.OD_COSMOS_ENDPOINT;
  const key = process.env.OD_COSMOS_KEY;
  if (!endpoint || !key) return;

  const dbName = process.env.OD_COSMOS_DATABASE || 'opendesign';
  const containerName = process.env.OD_COSMOS_CONTAINER || 'userdata';

  cosmosClient = new CosmosClient({ endpoint, key });
  const { database } = await cosmosClient.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: containerName,
    partitionKey: { paths: ['/userId'] },
  });
  cosmosContainer = container;
  console.log(`[cosmos-sync] connected to ${endpoint} / ${dbName} / ${containerName}`);
}

/** Register the user-db getter so the sync loop can resolve user DBs. */
export function registerUserDbGetter(getter: (userId: string) => { db: SqliteDb; dataDir: string }): void {
  userDbGetter = getter;
}

/**
 * Hydrate a per-user SQLite database from Cosmos.
 * Called once per user on their first request after container start.
 * Returns true if any data was loaded.
 */
export async function hydrateFromCosmos(db: SqliteDb, userId: string): Promise<boolean> {
  if (!cosmosContainer || hydratedUsers.has(userId)) return false;

  console.log(`[cosmos-sync] hydrating user ${userId} from Cosmos...`);
  let loaded = 0;

  try {
    const { resources } = await cosmosContainer.items.query({
      query: 'SELECT * FROM c WHERE c.userId = @userId',
      parameters: [{ name: '@userId', value: userId }],
    }).fetchAll();

    if (resources.length === 0) {
      hydratedUsers.add(userId);
      console.log(`[cosmos-sync] user ${userId}: no data in Cosmos (new user)`);
      return false;
    }

    // Group by table for ordered insertion (respect foreign keys).
    const byTable = new Map<string, any[]>();
    for (const doc of resources) {
      const list = byTable.get(doc.table) || [];
      list.push(doc.data);
      byTable.set(doc.table, list);
    }

    // Insert in FK-safe order: parent tables first.
    const insertOrder = [
      'projects', 'templates', 'routines',
      'conversations', 'deployments', 'tabs',
      'messages', 'preview_comments', 'routine_runs',
      'media_tasks', 'critique_runs',
    ];

    // Temporarily disable foreign keys during bulk load for robustness.
    db.pragma('foreign_keys = OFF');
    try {
      for (const table of insertOrder) {
        const rows = byTable.get(table);
        if (!rows || rows.length === 0) continue;
        for (const row of rows) {
          insertRowInto(db, table, row);
          loaded++;
        }
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }

    hydratedUsers.add(userId);
    console.log(`[cosmos-sync] user ${userId}: loaded ${loaded} rows from Cosmos`);
    return loaded > 0;
  } catch (err: any) {
    console.error(`[cosmos-sync] hydrate error for ${userId}:`, err.message);
    // Still mark as hydrated so we don't retry endlessly.
    hydratedUsers.add(userId);
    return false;
  }
}

/**
 * Generic INSERT OR REPLACE into a SQLite table from a plain row object.
 */
function insertRowInto(db: SqliteDb, table: string, data: Record<string, any>): void {
  const cols = Object.keys(data);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
  try {
    db.prepare(sql).run(...cols.map(c => data[c]));
  } catch (err: any) {
    // Log but don't crash — individual rows may have schema mismatches
    // if Cosmos data predates a migration.
    console.warn(`[cosmos-sync] insert into ${table} failed:`, err.message);
  }
}

/**
 * Sync all data from a per-user SQLite database to Cosmos.
 * This is a full dump — every row is upserted, deleted rows are removed.
 */
export async function syncUserToCosmos(db: SqliteDb, userId: string): Promise<void> {
  if (!cosmosContainer) return;

  // Collect all local row IDs per table.
  const localIds = new Set<string>();

  for (const tableDef of TABLES) {
    const { name: table, compositeKey } = tableDef;
    let rows: Record<string, any>[];
    try {
      rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, any>[];
    } catch {
      // Table may not exist in older user DBs.
      continue;
    }

    for (const row of rows) {
      const docId = cosmosDocId(table, row, compositeKey);
      localIds.add(docId);
      try {
        await cosmosContainer.items.upsert({
          id: docId,
          userId,
          table,
          data: row,
        });
      } catch (err: any) {
        console.warn(`[cosmos-sync] upsert ${docId} failed:`, err.message);
      }
    }
  }

  // Delete Cosmos documents that no longer exist locally.
  try {
    const { resources } = await cosmosContainer.items.query({
      query: 'SELECT c.id FROM c WHERE c.userId = @userId',
      parameters: [{ name: '@userId', value: userId }],
    }).fetchAll();

    for (const doc of resources) {
      if (!localIds.has(doc.id)) {
        try {
          await cosmosContainer.item(doc.id, userId).delete();
        } catch {
          // ignore — may already be deleted
        }
      }
    }
  } catch (err: any) {
    console.warn(`[cosmos-sync] deletion sweep failed for ${userId}:`, err.message);
  }
}

/** Mark a user as dirty (has unsaved changes). */
export function markDirty(userId: string): void {
  dirtyUsers.add(userId);
}

/**
 * Start the periodic sync loop. Runs every `intervalMs` (default 30s).
 * Only syncs users that have been marked dirty.
 */
export function startSyncLoop(intervalMs = 30_000): void {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    if (!cosmosContainer || !userDbGetter || dirtyUsers.size === 0) return;
    const users = [...dirtyUsers];
    dirtyUsers.clear();
    for (const userId of users) {
      try {
        const { db } = userDbGetter(userId);
        await syncUserToCosmos(db, userId);
      } catch (err: any) {
        console.warn(`[cosmos-sync] periodic sync failed for ${userId}:`, err.message);
        // Re-mark as dirty so we retry next cycle.
        dirtyUsers.add(userId);
      }
    }
  }, intervalMs);
  if (syncTimer.unref) syncTimer.unref();
  console.log(`[cosmos-sync] sync loop started (interval=${intervalMs}ms)`);
}

/** Stop the sync loop and flush all dirty users. */
export async function stopSync(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (!cosmosContainer || !userDbGetter) return;

  // Final flush.
  const users = [...dirtyUsers];
  dirtyUsers.clear();
  for (const userId of users) {
    try {
      const { db } = userDbGetter(userId);
      await syncUserToCosmos(db, userId);
    } catch (err: any) {
      console.error(`[cosmos-sync] final flush failed for ${userId}:`, err.message);
    }
  }
  console.log('[cosmos-sync] stopped');
}

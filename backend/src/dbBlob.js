/**
 * Blob-backed database driver (EdgeOne Makers Cloud Functions mode).
 *
 * Mirrors the dbLocal.js API but persists the whole DB document to Blob storage
 * (namespace "protobuddy"). All functions are async; the in-memory document is
 * loaded lazily from Blob on first access and rewritten on every mutation.
 *
 * Requires the "@edgeone/pages-blob" package, which is only available inside
 * EdgeOne Makers Cloud Functions (or with projectId/token for external access).
 */
import { getStore } from '@edgeone/pages-blob';

const DB_KEY = 'db/db.json';
const STORE_NAME = 'protobuddy';

let storePromise = null;
function getStoreInstance() {
  if (!storePromise) {
    // Strong consistency so a write is always immediately readable.
    storePromise = getStore({ name: STORE_NAME, consistency: 'strong' });
  }
  return storePromise;
}

const defaultDB = {
  projects: [],
  files: [],
  deployments: [],
  annotations: [],
  plans: [],
  planChanges: [],
  tasks: [],
  settings: {},
  _seq: 0
};

let db = null;

/**
 * Load (or reload) the DB document from Blob storage.
 *
 * IMPORTANT: serverless functions run on MULTIPLE instances. A module-level
 * cache ("load once, then serve from memory") causes instances to serve
 * stale data after another instance writes (observed with deployments: the
 * deploy instance updated the project, another instance kept answering with
 * the old record). Reload before EVERY operation — Blob strong-consistency
 * reads are fast enough and the dataset is tiny.
 */
async function ensureLoaded() {
  const store = await getStoreInstance();
  let raw = null;
  try {
    raw = await store.get(DB_KEY);
  } catch (e) {
    console.error('[db-blob] Failed to read db.json, starting fresh:', e.message);
  }
  if (raw) {
    try {
      db = JSON.parse(raw);
    } catch (e) {
      console.error('[db-blob] Failed to parse db.json, starting fresh:', e.message);
      db = JSON.parse(JSON.stringify(defaultDB));
    }
  } else {
    db = JSON.parse(JSON.stringify(defaultDB));
  }
}

async function save() {
  const store = await getStoreInstance();
  await store.set(DB_KEY, JSON.stringify(db));
}

export async function nextId() {
  await ensureLoaded();
  db._seq = (db._seq || 0) + 1;
  await save();
  return db._seq;
}

export async function getAll(table) {
  await ensureLoaded();
  return JSON.parse(JSON.stringify(db[table] || []));
}

export async function getById(table, id) {
  await ensureLoaded();
  const list = db[table] || [];
  return list.find(r => String(r.id) === String(id)) || null;
}

export async function insert(table, record) {
  await ensureLoaded();
  if (!db[table]) db[table] = [];
  // NOTE: do NOT call nextId() here — it re-runs ensureLoaded() which reloads
  // the whole DB document from Blob, wiping out the freshly-created table above
  // (a new table like `ownerAuth` does not exist in Blob yet, so after the
  // reload db[table] is undefined again and the push below throws
  // "Cannot read properties of undefined (reading 'push')"). Generate the id
  // inline against the already-loaded in-memory document instead.
  let id = record.id;
  if (!id) {
    db._seq = (db._seq || 0) + 1;
    id = db._seq;
  }
  const now = new Date().toISOString();
  const full = { id, created_at: now, updated_at: now, ...record, id };
  db[table].push(full);
  await save();
  return full;
}

export async function update(table, id, patch) {
  await ensureLoaded();
  const list = db[table] || [];
  const idx = list.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, updated_at: new Date().toISOString() };
  await save();
  return list[idx];
}

export async function remove(table, id) {
  await ensureLoaded();
  const list = db[table] || [];
  const idx = list.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return false;
  list.splice(idx, 1);
  await save();
  return true;
}

export async function query(table, predicate) {
  await ensureLoaded();
  return JSON.parse(JSON.stringify((db[table] || []).filter(predicate)));
}

export async function getSetting(key, defaultVal) {
  await ensureLoaded();
  return db.settings[key] ?? defaultVal;
}

export async function setSetting(key, value) {
  await ensureLoaded();
  if (!db.settings) db.settings = {};
  db.settings[key] = value;
  await save();
}

export async function removeSetting(key) {
  await ensureLoaded();
  if (db.settings && key in db.settings) {
    delete db.settings[key];
    await save();
  }
}

export { db };

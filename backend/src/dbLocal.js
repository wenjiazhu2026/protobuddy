import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Default schema
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

// Lazy init: NO module-scope I/O. This module may be evaluated inside a
// read-only function runtime (EdgeOne Makers), so filesystem work only happens
// when the local driver is actually used.
let db = null;

function getDb() {
  if (db) return db;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[db-local] Failed to load db.json, starting fresh:', e.message);
  }
  if (!db) {
    db = JSON.parse(JSON.stringify(defaultDB));
  }
  return db;
}

// Persist to disk (sync for simplicity in prototype)
function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(getDb(), null, 2), 'utf-8');
  } catch (e) {
    console.error('[db-local] Failed to save db.json:', e.message);
  }
}

// Generate sequential ID
export function nextId() {
  const d = getDb();
  d._seq = (d._seq || 0) + 1;
  save();
  return d._seq;
}

// Generic CRUD helpers
export function getAll(table) {
  return getDb()[table] || [];
}

export function getById(table, id) {
  return (getDb()[table] || []).find(r => String(r.id) === String(id));
}

export function insert(table, record) {
  const d = getDb();
  if (!d[table]) d[table] = [];
  const id = record.id || nextId();
  const now = new Date().toISOString();
  const full = { id, created_at: now, updated_at: now, ...record, id };
  d[table].push(full);
  save();
  return full;
}

export function update(table, id, patch) {
  const d = getDb();
  const list = d[table] || [];
  const idx = list.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, updated_at: new Date().toISOString() };
  save();
  return list[idx];
}

export function remove(table, id) {
  const d = getDb();
  const list = d[table] || [];
  const idx = list.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return false;
  list.splice(idx, 1);
  save();
  return true;
}

export function query(table, predicate) {
  return (getDb()[table] || []).filter(predicate);
}

export function getSetting(key, defaultVal) {
  return getDb().settings[key] ?? defaultVal;
}

export function setSetting(key, value) {
  const d = getDb();
  if (!d.settings) d.settings = {};
  d.settings[key] = value;
  save();
}

export function removeSetting(key) {
  const d = getDb();
  if (d.settings && key in d.settings) {
    delete d.settings[key];
    save();
  }
}

export { db };

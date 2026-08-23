/**
 * Database driver dispatcher.
 *
 * - STORAGE_DRIVER=blob  -> Blob-backed store (EdgeOne Makers Cloud Functions)
 * - default              -> local JSON file store (fs)
 *
 * All exported functions are async so routes can `await` them uniformly.
 *
 * IMPORTANT (EdgeOne Makers): both drivers are loaded LAZILY via dynamic
 * import. dbLocal.js performs filesystem I/O at module scope (mkdir/read),
 * which is fine on a dev machine but throws on the platform's read-only
 * function filesystem — evaluating it statically would fail the whole bundle
 * at load time and every /api request would hang. Dynamic import defers
 * evaluation until the local driver is actually used (never in blob mode).
 */
import { isBlobMode } from './config.js';

let localDbPromise = null;
function localDb() {
  if (!localDbPromise) {
    localDbPromise = import('./dbLocal.js').catch(err => {
      localDbPromise = null;
      throw err;
    });
  }
  return localDbPromise;
}

let blobDbPromise = null;
function blobDb() {
  if (!blobDbPromise) {
    blobDbPromise = import('./dbBlob.js').catch(err => {
      blobDbPromise = null;
      throw err;
    });
  }
  return blobDbPromise;
}

function driver() {
  return isBlobMode() ? blobDb() : localDb();
}

export function nextId() {
  return driver().then(m => m.nextId());
}

export function getAll(table) {
  return driver().then(m => m.getAll(table));
}

export function getById(table, id) {
  return driver().then(m => m.getById(table, id));
}

export function insert(table, record) {
  return driver().then(m => m.insert(table, record));
}

export function update(table, id, patch) {
  return driver().then(m => m.update(table, id, patch));
}

export function remove(table, id) {
  return driver().then(m => m.remove(table, id));
}

export function query(table, predicate) {
  return driver().then(m => m.query(table, predicate));
}

export function getSetting(key, defaultVal) {
  return driver().then(m => m.getSetting(key, defaultVal));
}

export function setSetting(key, value) {
  return driver().then(m => m.setSetting(key, value));
}

export function removeSetting(key) {
  return driver().then(m => m.removeSetting(key));
}

export function getDbObject() {
  return driver().then(m => m.db);
}

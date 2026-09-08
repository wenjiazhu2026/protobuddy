/**
 * Blob-backed file storage driver (EdgeOne Makers Cloud Functions mode).
 *
 * Mirrors the fileStorageLocal.js API but stores prototype files as objects in
 * Blob storage under the "protobuddy" namespace, keys: projects/<id>/<relPath>.
 * All functions are async. Requires "@edgeone/pages-blob".
 */
import AdmZip from 'adm-zip';
import { getStore } from '@edgeone/pages-blob';

const STORE_NAME = 'protobuddy';
const PREFIX = 'projects/';

const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.mp3', '.pdf', '.zip', '.rar'];

let storePromise = null;
function getStoreInstance() {
  if (!storePromise) {
    storePromise = getStore({ name: STORE_NAME, consistency: 'strong' });
  }
  return storePromise;
}

function keyFor(projectId, relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  return `${PREFIX}${projectId}/${rel}`;
}

// Convert a Node Buffer (Uint8Array) to a plain ArrayBuffer.
// The Pages Blob SDK's BlobInput type only accepts
// string | ArrayBuffer | Blob | ReadableStream — passing a raw Buffer is not
// part of the declared contract and can be rejected by undici's fetch.
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function normalizeRel(relPath) {
  let rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  // Remove any '..' segments to prevent traversal
  const parts = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function isBinaryFile(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return BINARY_EXTS.some(ext => lower.endsWith(ext));
}

export async function getProjectDir() {
  return '';
}

export async function ensureProjectDir() {
  return true;
}

// Unzip a buffer into Blob storage, return list of files
export async function unzipToProject(projectId, zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const store = await getStoreInstance();
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = normalizeRel(entry.entryName);
    if (!name) continue;
    const base = name.split('/').pop();
    if (base === '.DS_Store' || base === 'Thumbs.db') continue;

    const buf = entry.getData();
    if (isBinaryFile(name)) {
      await store.set(keyFor(projectId, name), toArrayBuffer(buf));
    } else {
      await store.set(keyFor(projectId, name), buf.toString('utf-8'));
    }
    files.push(name);
  }
  return files;
}

// Delete all objects under projects/<id>/
export async function clearProjectFiles(projectId) {
  const store = await getStoreInstance();
  const { blobs } = await store.list({ prefix: keyFor(projectId, '') });
  for (const b of blobs) {
    await store.delete(b.key);
  }
}

/**
 * Write uploaded files (folder / single-file upload). Clears previous content.
 * @param {number|string} projectId
 * @param {Array<{relPath: string, buffer: Buffer}>} files
 * @returns {Promise<string[]>}
 */
export async function writeUploadedFiles(projectId, files) {
  await clearProjectFiles(projectId);

  const store = await getStoreInstance();
  const written = [];
  for (const f of files) {
    const rel = normalizeRel(f.relPath);
    if (!rel) continue;
    const base = rel.split('/').pop();
    if (base === '.DS_Store' || base === 'Thumbs.db') continue;

    if (isBinaryFile(rel)) {
      await store.set(keyFor(projectId, rel), toArrayBuffer(f.buffer));
    } else {
      await store.set(keyFor(projectId, rel), f.buffer.toString('utf-8'));
    }
    written.push(rel);
  }
  return written;
}

async function tryRead(projectId, filePath) {
  const store = await getStoreInstance();
  const key = keyFor(projectId, normalizeRel(filePath));
  const exists = await store.get(key);
  if (exists === null) return null;

  if (isBinaryFile(key)) {
    const ab = await store.get(key, { type: 'arrayBuffer' });
    const buf = Buffer.from(ab);
    return { binary: true, data: buf.toString('base64') };
  }
  const text = await store.get(key, { type: 'text' });
  return { binary: false, data: text === null ? '' : String(text) };
}

async function exists(projectId, filePath) {
  const store = await getStoreInstance();
  const v = await store.get(keyFor(projectId, normalizeRel(filePath)));
  return v !== null;
}

// Read a file: try direct path, then with entry-point subdir prefix
export async function readFileContent(projectId, filePath) {
  const direct = await tryRead(projectId, filePath);
  if (direct) return direct;

  const entry = await findEntryPoint(projectId);
  if (entry) {
    const viaEntry = await tryRead(projectId, `${entry}/${filePath}`);
    if (viaEntry) return viaEntry;
  }
  return null;
}

// Write content back to a file.
// Resolves the target path:
// - If the given path already exists, it is updated in place.
// - Else if the same file already exists under the entry subdir (a bare path
//   like 'index.html' while the real file is '原型设计/index.html'), update that.
// - Otherwise write at the given path EXACTLY — creates a NEW file where the
//   caller asked, without silently prefixing the entry dir (the old behaviour
//   double-prefixed new files, e.g. '原型设计/agents.md' -> '原型设计/原型设计/agents.md').
export async function writeFileContent(projectId, filePath, content) {
  const store = await getStoreInstance();
  const rel = normalizeRel(filePath);
  if (!rel) return false;

  let target = rel;
  const entry = await findEntryPoint(projectId);
  if (entry) {
    const withPrefix = `${entry}/${rel}`;
    if (withPrefix !== rel && (await exists(projectId, withPrefix))) {
      target = withPrefix;
    }
  }

  if (isBinaryFile(target)) {
    const buf = typeof content === 'string' ? Buffer.from(content, 'base64') : content;
    await store.set(keyFor(projectId, target), toArrayBuffer(buf));
  } else {
    await store.set(keyFor(projectId, target), String(content));
  }
  return true;
}

// Delete a file
export async function deleteFile(projectId, filePath) {
  const store = await getStoreInstance();
  const key = keyFor(projectId, normalizeRel(filePath));
  const v = await store.get(key);
  if (v === null) return false;
  await store.delete(key);
  return true;
}

// Find entry point (index.html): root first, else any subdirectory
export async function findEntryPoint(projectId) {
  const store = await getStoreInstance();
  const rootIndex = await store.get(keyFor(projectId, 'index.html'));
  if (rootIndex !== null) return '';

  const { blobs } = await store.list({ prefix: keyFor(projectId, '') });
  const match = blobs.map(b => b.key).find(k => /\/index\.html$/.test(k));
  if (!match) return '';
  const prefixLen = keyFor(projectId, '').length;
  return match.slice(prefixLen).replace(/\/index\.html$/, '') || '';
}

// Approximate file size in bytes
export async function getFileSize(projectId, filePath) {
  const content = await readFileContent(projectId, filePath);
  if (!content) return 0;
  if (content.binary) {
    return Buffer.from(content.data, 'base64').length;
  }
  return Buffer.byteLength(String(content.data), 'utf-8');
}

/* ------------------------- chunked upload -------------------------
 * EdgeOne Makers functions cap the REQUEST body at 6 MiB (a payload of
 * exactly 6291456 bytes short-circuits with a platform 500 before any app
 * code runs), so prototype folders with images routinely fail. Chunked
 * upload splits the payload into sub-6MiB requests under a client-generated
 * uploadId; /upload/finish then concatenates the parts into the project.
 * Parts are stored under projects/__parts__/<projectId>/<uploadId>/<relPath>/part<i>.
 */
export async function saveChunk(projectId, uploadId, relPath, index, buffer) {
  const store = await getStoreInstance();
  const key = `${PREFIX}__parts__/${projectId}/${uploadId}/${normalizeRel(relPath)}/part${index}`;
  await store.set(key, toArrayBuffer(buffer));
  return true;
}

export async function clearUploadParts(projectId, uploadId) {
  const store = await getStoreInstance();
  const { blobs } = await store.list({ prefix: `${PREFIX}__parts__/${projectId}/${uploadId}/` });
  for (const b of blobs) {
    await store.delete(b.key);
  }
}

export async function readChunk(projectId, uploadId, relPath, index) {
  const store = await getStoreInstance();
  const key = `${PREFIX}__parts__/${projectId}/${uploadId}/${normalizeRel(relPath)}/part${index}`;
  const ab = await store.get(key, { type: 'arrayBuffer' });
  return ab === null ? null : Buffer.from(ab);
}

/**
 * Concatenate previously uploaded parts into the final project files.
 * @param {number|string} projectId
 * @param {string} uploadId - session id generated by the client
 * @param {Array<{path: string, chunkCount: number}>} files
 * @returns {Promise<string[]>} written relative paths
 */
export async function finalizeUpload(projectId, uploadId, files) {
  const store = await getStoreInstance();
  const prefix = `${PREFIX}__parts__/${projectId}/${uploadId}/`;
  const written = [];
  for (const f of files) {
    const rel = normalizeRel(f.path);
    if (!rel) continue;
    const parts = [];
    let missing = false;
    for (let i = 0; i < (f.chunkCount || 1); i++) {
      const ab = await store.get(prefix + `${rel}/part${i}`, { type: 'arrayBuffer' });
      if (ab === null) { missing = true; break; }
      parts.push(Buffer.from(ab));
    }
    if (missing) continue;
    const total = parts.length === 1 ? parts[0] : Buffer.concat(parts, parts.reduce((s, b) => s + b.length, 0));
    const key = keyFor(projectId, rel);
    if (isBinaryFile(rel)) {
      await store.set(key, toArrayBuffer(total));
    } else {
      await store.set(key, total.toString('utf-8'));
    }
    written.push(rel);
  }
  await clearUploadParts(projectId, uploadId);
  return written;
}

// List all file paths (relative) in a project
export async function listProjectFiles(projectId) {
  const store = await getStoreInstance();
  const { blobs } = await store.list({ prefix: keyFor(projectId, '') });
  const prefixLen = keyFor(projectId, '').length;
  return blobs.map(b => b.key.slice(prefixLen));
}

// Remove all project files
export async function removeProjectFiles(projectId) {
  await clearProjectFiles(projectId);
  return true;
}

export async function getProjectRoot() {
  return '';
}

export { BINARY_EXTS };

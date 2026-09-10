import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'data', 'projects');

// Lazy: NO module-scope I/O (this module may be evaluated inside a read-only
// function runtime; mkdir only happens when the local driver is actually used).
let ensured = false;
function ensureRootDir() {
  if (ensured) return;
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('[file-local] Cannot create projects dir:', e.message);
  }
  ensured = true;
}

export function getProjectDir(projectId) {
  ensureRootDir();
  const dir = path.join(PROJECTS_DIR, String(projectId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Unzip a buffer into the project directory, return list of files
export function unzipToProject(projectId, zipBuffer) {
  const projectDir = getProjectDir(projectId);
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(projectDir, true);

  // Collect all files (skip directories, hidden files, and common junk)
  const files = [];
  function walk(dir, relBase = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else {
        // Skip OS junk files
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
        files.push(relPath);
      }
    }
  }
  walk(projectDir);
  return files;
}

// Clear all existing files in a project directory (keeps the directory itself)
export function clearProjectFiles(projectId) {
  const projectDir = getProjectDir(projectId);
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    fs.rmSync(path.join(projectDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * Write a list of uploaded files (folder upload or single-file upload) into the project.
 * Clears previous content first, then writes each file at its relative path.
 *
 * @param {number} projectId - Project id
 * @param {Array<{relPath: string, buffer: Buffer}>} files - Files to write
 * @returns {string[]} List of written file paths (relative)
 */
export function writeUploadedFiles(projectId, files) {
  const projectDir = getProjectDir(projectId);
  clearProjectFiles(projectId);

  const written = [];
  for (const f of files) {
    // Normalize path and guard against traversal
    const rel = String(f.relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = path.normalize(rel);
    if (!normalized || normalized.startsWith('..')) continue;
    if (path.basename(normalized) === '.DS_Store' || path.basename(normalized) === 'Thumbs.db') continue;

    const fullPath = path.join(projectDir, normalized);
    if (!fullPath.startsWith(projectDir)) continue;

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, f.buffer);
    written.push(normalized);
  }
  return written;
}

// Resolve a file path: try direct, then with entry point subdir prefix.
// SECURITY: every resolved path MUST stay inside the project directory —
// `filePath` comes from user requests and may contain `..` segments; without
// this guard a crafted path escapes the project dir (arbitrary read/write).
function resolveFilePath(projectId, filePath) {
  const projectDir = getProjectDir(projectId);
  const rel = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;

  const directPath = path.resolve(projectDir, rel);
  if (directPath !== projectDir && !directPath.startsWith(projectDir + path.sep)) return null;
  if (fs.existsSync(directPath)) return directPath;

  // Try with entry point subdir
  const entrySubdir = findEntryPoint(projectId);
  if (entrySubdir) {
    const subPath = path.resolve(projectDir, entrySubdir, rel);
    if (subPath.startsWith(projectDir + path.sep) && fs.existsSync(subPath)) return subPath;
  }

  return null;
}

const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.mp3', '.pdf', '.zip', '.rar'];

export function isBinaryFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return BINARY_EXTS.includes(ext);
}

// Read a file's content from project directory
export function readFileContent(projectId, filePath) {
  const fullPath = resolveFilePath(projectId, filePath);
  if (!fullPath) return null;

  // A directory path (e.g. "phase-2/") must not be read as a file: readFileSync
  // throws EISDIR, which surfaced as a 500 instead of a plain "not found".
  try {
    if (fs.statSync(fullPath).isDirectory()) return null;
  } catch {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  if (BINARY_EXTS.includes(ext)) {
    // Return base64 for binary files
    const buf = fs.readFileSync(fullPath);
    return { binary: true, data: buf.toString('base64') };
  }

  return { binary: false, data: fs.readFileSync(fullPath, 'utf-8') };
}

// Write content back to a file
export function writeFileContent(projectId, filePath, content) {
  // Try to find existing file first
  const existingPath = resolveFilePath(projectId, filePath);
  if (existingPath) {
    fs.writeFileSync(existingPath, content, 'utf-8');
    return true;
  }
  // New file: write to entry point subdir or root.
  // SECURITY: same traversal guard as resolveFilePath — the resolved path
  // must stay inside the project directory.
  const rel = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return false;
  const projectDir = getProjectDir(projectId);
  const entrySubdir = findEntryPoint(projectId);
  const fullPath = path.resolve(projectDir, entrySubdir || '', rel);
  if (!fullPath.startsWith(projectDir + path.sep)) return false;
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return true;
}

// Delete a file
export function deleteFile(projectId, filePath) {
  const fullPath = resolveFilePath(projectId, filePath);
  if (fullPath && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    return true;
  }
  return false;
}

// Find the entry point (index.html): the project root wins; otherwise the
// SHALLOWEST directory holding an index.html.
//
// Recursive (the old version only looked one level deep, so a project whose
// entry sat deeper had no entry at all) and depth-first rather than
// "first directory found": a nested sub-app page (e.g.
// `原型设计/call-analysis/index.html`) must never shadow the project's own
// entry page (`原型设计/index.html`).
export function findEntryPoint(projectId) {
  const projectDir = getProjectDir(projectId);

  // Root index.html wins outright
  if (fs.existsSync(path.join(projectDir, 'index.html'))) return '';

  const dirs = [];
  const MAX_DEPTH = 5;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(dir, entry.name, 'index.html'))) dirs.push(childRel);
      walk(path.join(dir, entry.name), childRel, depth + 1);
    }
  };
  walk(projectDir, '', 1);

  if (!dirs.length) return '';
  dirs.sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  return dirs[0];
}

// Get the absolute path for serving static files
export function getProjectRoot(projectId) {
  return getProjectDir(projectId);
}

// File size in bytes (async-compatible signature)
export function getFileSize(projectId, filePath) {
  const fullPath = resolveFilePath(projectId, filePath);
  if (!fullPath) return 0;
  try {
    return fs.statSync(fullPath).size;
  } catch (e) {
    return 0;
  }
}

// List all file paths (relative) in a project
export function listProjectFiles(projectId) {
  const projectDir = getProjectDir(projectId);
  const files = [];
  function walk(dir, relBase = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else {
        files.push(relPath.split(path.sep).join('/'));
      }
    }
  }
  walk(projectDir);
  return files;
}

// Ensure project directory exists (no-op when already created lazily)
export function ensureProjectDir(projectId) {
  getProjectDir(projectId);
  return projectId;
}

// Remove all project files (including the directory itself)
export function removeProjectFiles(projectId) {
  const dir = getProjectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

/* ------------------------- chunked upload -------------------------
 * Mirrors fileStorageBlob's chunked-upload contract (client posts <=6MiB
 * parts under an uploadId, then calls /upload/finish). Parts are staged
 * OUTSIDE the project dir (backend/data/.pb-parts/<projectId>/<uploadId>/<relPath>/part<i>)
 * so that clearProjectFiles() — which wipes the project dir — never
 * deletes in-flight parts.
 */
function partsDir(projectId, uploadId) {
  return path.join(PROJECTS_DIR, '..', '.pb-parts', String(projectId), String(uploadId));
}

// Normalize a relative path and reject traversal (returns '' when unsafe).
function safeRel(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return '';
  const norm = path.normalize(rel);
  if (norm === '.' || norm.startsWith('..') || path.isAbsolute(norm)) return '';
  return norm.split(path.sep).join('/');
}

export function saveChunk(projectId, uploadId, relPath, index, buffer) {
  const rel = safeRel(relPath);
  if (!rel) return false;
  const base = partsDir(projectId, uploadId);
  const full = path.join(base, rel, `part${index}`);
  if (!full.startsWith(base + path.sep)) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return true;
}

export function clearUploadParts(projectId, uploadId) {
  const dir = partsDir(projectId, uploadId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function readChunk(projectId, uploadId, relPath, index) {
  const rel = safeRel(relPath);
  if (!rel) return null;
  const p = path.join(partsDir(projectId, uploadId), rel, `part${index}`);
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

export function finalizeUpload(projectId, uploadId, files) {
  const projectDir = getProjectDir(projectId);
  const base = partsDir(projectId, uploadId);
  const written = [];
  for (const f of files) {
    const rel = safeRel(f.path);
    if (!rel) continue;
    if (path.basename(rel) === '.DS_Store' || path.basename(rel) === 'Thumbs.db') continue;
    const chunkDir = path.join(base, rel);
    const parts = [];
    let missing = false;
    for (let i = 0; i < (f.chunkCount || 1); i++) {
      const p = path.join(chunkDir, `part${i}`);
      if (!fs.existsSync(p)) { missing = true; break; }
      parts.push(fs.readFileSync(p));
    }
    if (missing) continue;
    const fullPath = path.join(projectDir, rel);
    if (fullPath !== projectDir && !fullPath.startsWith(projectDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, parts.length === 1 ? parts[0] : Buffer.concat(parts));
    written.push(rel);
  }
  clearUploadParts(projectId, uploadId);
  return written;
}

export { PROJECTS_DIR };

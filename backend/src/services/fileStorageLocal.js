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

// Find the entry point (index.html) - might be at root or in a subdirectory
export function findEntryPoint(projectId) {
  const projectDir = getProjectDir(projectId);

  // Try root index.html first
  const rootIndex = path.join(projectDir, 'index.html');
  if (fs.existsSync(rootIndex)) return '';

  // Search subdirectories (one level deep)
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subIndex = path.join(projectDir, entry.name, 'index.html');
      if (fs.existsSync(subIndex)) return entry.name;
    }
  }

  return '';
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

export { PROJECTS_DIR };

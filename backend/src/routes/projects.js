import { Router } from 'express';
import multer from 'multer';
import { getAll, getById, insert, update, remove, query, removeSetting } from '../db.js';
import { unzipToProject, writeUploadedFiles, clearProjectFiles, ensureProjectDir, getFileSize, removeProjectFiles, saveChunk, readChunk, finalizeUpload, clearUploadParts } from '../services/fileStorage.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// ---- Project creation rate limit + caps ------------------------------------
// POST / is a bootstrap operation (no project exists yet to verify owner
// auth against), so instead of a token we limit abuse with:
//   1) IP-based rate limit (max CREATE_RATE per CREATE_WINDOW_MS)
//   2) Total project cap (max MAX_PROJECTS) to bound storage consumption
//   3) Strict input sanitization (name/slug/etc. stripped + length-capped)
const CREATE_RATE = parseInt(process.env.CREATE_RATE || '', 10) || 5;
const CREATE_WINDOW_MS = parseInt(process.env.CREATE_WINDOW_MS || '', 10) || 60 * 60 * 1000; // 1h
const MAX_PROJECTS = parseInt(process.env.MAX_PROJECTS || '', 10) || 100;
const createHits = new Map(); // ip -> timestamp[]
function createRateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const hits = (createHits.get(key) || []).filter(t => now - t < CREATE_WINDOW_MS);
  createHits.set(key, hits);
  if (hits.length >= CREATE_RATE) return true;
  hits.push(now);
  return false;
}

// Upload limits: memoryStorage buffers every file in RAM, so the limits bound
// worst-case memory usage per request (previously 500 × 50MB = 25GB → instant
// OOM). Prototype uploads need far less: 25MB per file, 200 files, 150MB total.
const UPLOAD_FILE_SIZE = parseInt(process.env.UPLOAD_FILE_SIZE_MB || '', 10) * 1024 * 1024 || 25 * 1024 * 1024;
const UPLOAD_MAX_FILES = parseInt(process.env.UPLOAD_MAX_FILES || '', 10) || 200;
const UPLOAD_TOTAL_BYTES = parseInt(process.env.UPLOAD_TOTAL_MB || '', 10) * 1024 * 1024 || 150 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_SIZE, files: UPLOAD_MAX_FILES }
});

// List all projects
router.get('/', async (req, res) => {
  const projects = await getAll('projects');
  res.json(projects.map(p => ({
    ...p,
    edgeone_token: undefined,
    makers_key: undefined  // Never expose keys
  })));
});

// Get single project
router.get('/:id', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({
    ...project,
    edgeone_token: project.edgeone_token ? '***' : '',
    makers_key: project.makers_key ? '***' : ''
  });
});

// Create project — rate-limited + capped (bootstrap op: no owner auth possible yet)
router.post('/', async (req, res) => {
  // Rate limit by client IP
  if (createRateLimited(req.ip)) {
    return res.status(429).json({
      error: 'CREATE_RATE_LIMITED',
      message: `项目创建过于频繁（每 ${Math.round(CREATE_WINDOW_MS / 60000)} 分钟最多 ${CREATE_RATE} 次），请稍后再试`
    });
  }
  // Total project cap (storage exhaustion guard)
  const existing = await getAll('projects');
  if (existing.length >= MAX_PROJECTS) {
    return res.status(507).json({ error: `已达到项目上限 (${MAX_PROJECTS})，请联系管理员` });
  }

  const raw = req.body || {};
  // Sanitize + length-cap all user-supplied strings to prevent stored XSS
  // and unbounded storage growth.
  const MAX_NAME = 200, MAX_STR = 500;
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const name = clean(raw.name, MAX_NAME);
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  const slug = clean(raw.slug, MAX_STR);
  const edgeone_project_name = clean(raw.edgeone_project_name, MAX_STR);
  const edgeone_token = clean(raw.edgeone_token, MAX_STR);
  const makers_key = clean(raw.makers_key, MAX_STR);
  const description = clean(raw.description, 2000);
  const custom_domain = clean(raw.custom_domain, MAX_STR);

  const projectSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `proj-${Date.now()}`;

  const project = await insert('projects', {
    name,
    slug: projectSlug,
    edgeone_project_name: edgeone_project_name || projectSlug,
    edgeone_token: edgeone_token || '',
    makers_key: makers_key || '',
    description: description || '',
    custom_domain: custom_domain || '',
    current_url: '',
    deploy_method: '',
    status: 'created',
    version: 0
  });

  // Create project storage location
  await ensureProjectDir(project.id);

  res.status(201).json({
    ...project,
    edgeone_token: project.edgeone_token ? '***' : '',
    makers_key: project.makers_key ? '***' : ''
  });
});

// Update project (including settings/keys) — owner maintenance operation
router.put('/:id', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { name, edgeone_project_name, edgeone_token, makers_key, description, makers_model, custom_domain } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (edgeone_project_name !== undefined) patch.edgeone_project_name = edgeone_project_name;
  if (edgeone_token !== undefined) patch.edgeone_token = edgeone_token;
  if (makers_key !== undefined) patch.makers_key = makers_key;
  if (description !== undefined) patch.description = description;
  if (makers_model !== undefined) patch.makers_model = makers_model;
  if (custom_domain !== undefined) patch.custom_domain = custom_domain;

  const updated = await update('projects', req.params.id, patch);
  res.json({
    ...updated,
    edgeone_token: updated.edgeone_token ? '***' : '',
    makers_key: updated.makers_key ? '***' : ''
  });
});

// Delete project — owner maintenance operation
router.delete('/:id', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  await remove('projects', req.params.id);
  // Clean up ALL related data. planChanges/snapshots/ownerAuth carry
  // project-scoped records (and gitlab settings may embed tokens), so leaving
  // orphans behind is both a data-integrity and a security issue.
  const relatedTables = ['files', 'deployments', 'annotations', 'plans', 'planChanges', 'snapshots', 'ownerAuth', 'tasks'];
  for (const table of relatedTables) {
    const recs = await query(table, r => String(r.project_id) === String(req.params.id));
    for (const r of recs) await remove(table, r.id);
  }
  // Per-project settings keys (taskBreakdownConfig / gitlabConfig incl. token)
  await removeSetting(`taskBreakdownConfig:${req.params.id}`);
  await removeSetting(`gitlabConfig:${req.params.id}`);

  // Delete project files
  await removeProjectFiles(req.params.id);

  res.json({ success: true });
});

/**
 * Upload prototype to a project.
 * Supports three upload types (field `type`):
 *   - zip    (default): `file` field = ZIP package (legacy behavior)
 *   - folder : `files[]` = multiple files, `paths[]` = relative paths (must contain index.html)
 *   - html   : `file` field = single index.html (or any .html file, stored as index.html)
 */
// Owner-gated: uploading a new prototype replaces existing files
router.post('/:id/upload', requireOwnerAuth, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: UPLOAD_MAX_FILES }]), async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const type = (req.body.type || 'zip').toLowerCase();
  const uploadedFile = req.files?.file?.[0];
  const uploadedFiles = req.files?.files || [];

  if (!uploadedFile && uploadedFiles.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Aggregate size guard (multer only limits per-file): bound total buffered
  // bytes per request so a folder upload cannot balloon memory usage.
  const totalBytes = [uploadedFile, ...uploadedFiles].filter(Boolean)
    .reduce((s, f) => s + (f.size || 0), 0);
  if (totalBytes > UPLOAD_TOTAL_BYTES) {
    return res.status(413).json({ error: `上传总体积超过上限 ${Math.round(UPLOAD_TOTAL_BYTES / 1024 / 1024)}MB` });
  }

  try {
    // Clear existing file records in DB
    const oldFiles = await query('files', f => String(f.project_id) === String(req.params.id));
    for (const f of oldFiles) await remove('files', f.id);

    let filePaths = [];

    if (type === 'folder') {
      // Folder upload: files[] + paths[] (paths must align 1:1 with files)
      const paths = Array.isArray(req.body.paths) ? req.body.paths : (req.body.paths ? [req.body.paths] : []);
      const pairs = uploadedFiles.map((f, i) => ({
        relPath: paths[i] || f.originalname,
        buffer: f.buffer
      }));

      // Require index.html somewhere in the folder
      const hasIndex = pairs.some(p => p.relPath.replace(/\\/g, '/').split('/').pop() === 'index.html');
      if (!hasIndex) {
        return res.status(400).json({ error: '上传的文件夹必须包含 index.html 文件' });
      }

      filePaths = await writeUploadedFiles(req.params.id, pairs);
    } else if (type === 'html') {
      // Single index.html upload
      if (!uploadedFile) return res.status(400).json({ error: 'No HTML file uploaded' });
      const name = (uploadedFile.originalname || '').toLowerCase();
      if (!name.endsWith('.html') && !name.endsWith('.htm')) {
        return res.status(400).json({ error: '请上传 index.html 文件' });
      }
      filePaths = await writeUploadedFiles(req.params.id, [{ relPath: 'index.html', buffer: uploadedFile.buffer }]);
    } else {
      // ZIP upload (default)
      if (!uploadedFile) return res.status(400).json({ error: 'No file uploaded' });
      await clearProjectFiles(req.params.id);
      filePaths = await unzipToProject(req.params.id, uploadedFile.buffer);
    }

    // Insert file records
    const files = [];
    for (const fp of filePaths) {
      const size = await getFileSize(req.params.id, fp);
      files.push(await insert('files', {
        project_id: req.params.id,
        path: fp,
        version: 1,
        size
      }));
    }

    await update('projects', req.params.id, {
      status: 'uploaded',
      version: (project.version || 0) + 1
    });

    res.json({
      success: true,
      fileCount: files.length,
      uploadType: type,
      files: files.map(f => ({ id: f.id, path: f.path, version: f.version }))
    });
  } catch (err) {
    console.error('[upload] Error:', err);
    res.status(500).json({ error: `Failed to process upload: ${err.message}` });
  }
});

/* ------------------------- Chunked upload -------------------------
 * EdgeOne Makers Cloud Functions cap the REQUEST body at 6 MiB — anything
 * larger short-circuits with a platform 500 before any app code runs (no
 * JSON error body, just the Tencent "500" page). Prototype folders with
 * images routinely exceed that, so the client uploads each <=4MiB slice as
 * its own request under a client-generated uploadId, then POSTs
 * /upload/finish to concatenate the parts into the final project files.
 */

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

// POST /:id/upload/chunk - one multipart body with a single `data` file field
// + text fields { uploadId, path, index }.
router.post('/:id/upload/chunk', requireOwnerAuth, upload.fields([{ name: 'data', maxCount: 1 }]), async (req, res) => {
  try {
    const chunk = req.files?.data?.[0];
    if (!chunk) return res.status(400).json({ error: 'Missing chunk data' });
    const uploadId = String(req.body.uploadId || '');
    if (!UPLOAD_ID_RE.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }
    const path = String(req.body.path || '').replace(/\\/g, '/');
    const index = parseInt(req.body.index || '', 10);
    if (!Number.isInteger(index) || index < 0 || index > 8192) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }
    await saveChunk(req.params.id, uploadId, path, index, chunk.buffer);
    res.json({ ok: true, index });
  } catch (err) {
    console.error('[upload/chunk] Error:', err);
    res.status(500).json({ error: `Failed to store chunk: ${err.message}` });
  }
});

// POST /:id/upload/finish - body: { uploadId, type, files:[{path, chunkCount}] }
// Concatenates parts, writes project files, inserts records, bumps version.
router.post('/:id/upload/finish', requireOwnerAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = await getById('projects', projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const uploadId = String(req.body.uploadId || '');
    if (!UPLOAD_ID_RE.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }
    const type = String(req.body.type || 'folder').toLowerCase();
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    if (files.length === 0) return res.status(400).json({ error: 'No files to finalize' });
    if (files.length > UPLOAD_MAX_FILES) {
      return res.status(400).json({ error: `文件数量超过上限 ${UPLOAD_MAX_FILES}` });
    }
    for (const f of files) {
      const n = parseInt(f.chunkCount, 10);
      if (!Number.isInteger(n) || n < 1 || n > 4096) {
        return res.status(400).json({ error: `Invalid chunkCount for ${f.path}` });
      }
    }

    try {
      // Replace the previous prototype content (parts live outside the
      // project namespace, so this never deletes in-flight chunks).
      await clearProjectFiles(projectId);

      let filePaths = [];
      if (type === 'zip') {
        // Reassemble the single package then unpack it.
        const pkg = files[0];
        const parts = [];
        for (let i = 0; i < pkg.chunkCount; i++) {
          const part = await readChunk(projectId, uploadId, pkg.path, i);
          if (part === null) throw new Error(`Missing chunk ${i} of ${pkg.path}`);
          parts.push(part);
        }
        const totalLen = parts.reduce((s, b) => s + b.length, 0);
        const assembled = Buffer.concat(parts, totalLen);
        await ensureProjectDir(projectId);
        filePaths = await unzipToProject(projectId, assembled);
      } else {
        const mapped = files.map(f => ({ path: type === 'html' ? 'index.html' : f.path, chunkCount: f.chunkCount }));
        filePaths = await finalizeUpload(projectId, uploadId, mapped);
      }

      const hasIndex = filePaths.some(fp => fp.replace(/\\/g, '/').split('/').pop() === 'index.html');
      if (!hasIndex && type !== 'zip') {
        await clearProjectFiles(projectId);
        return res.status(400).json({ error: '上传内容必须包含 index.html 文件' });
      }

      // Replace old file records.
      const oldFiles = await query('files', f => String(f.project_id) === String(projectId));
      for (const f of oldFiles) await remove('files', f.id);

      const filesOut = [];
      for (const fp of filePaths) {
        const size = await getFileSize(projectId, fp);
        filesOut.push(await insert('files', {
          project_id: projectId,
          path: fp,
          version: 1,
          size
        }));
      }
      await update('projects', projectId, {
        status: 'uploaded',
        version: (project.version || 0) + 1
      });

      try { await clearUploadParts(projectId, uploadId); } catch { /* best effort */ }

      res.json({
        success: true,
        fileCount: filesOut.length,
        uploadType: type,
        files: filesOut.map(f => ({ id: f.id, path: f.path, version: f.version }))
      });
    } catch (err) {
      console.error('[upload/finish] Error:', err);
      res.status(500).json({ error: `Failed to finalize upload: ${err.message}` });
    }
  } catch (err) {
    console.error('[upload/finish] Error:', err);
    res.status(500).json({ error: `Failed to finalize upload: ${err.message}` });
  }
});

export default router;

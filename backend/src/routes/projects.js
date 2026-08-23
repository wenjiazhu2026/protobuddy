import { Router } from 'express';
import multer from 'multer';
import { getAll, getById, insert, update, remove, query, removeSetting } from '../db.js';
import { unzipToProject, writeUploadedFiles, clearProjectFiles, ensureProjectDir, getFileSize, removeProjectFiles } from '../services/fileStorage.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();
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

// Create project
router.post('/', async (req, res) => {
  const { name, slug, edgeone_project_name, edgeone_token, makers_key, description, custom_domain } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });

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

export default router;

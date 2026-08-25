import { Router } from 'express';
import { getById, query, insert, update, remove } from '../db.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// List annotations for a project (optionally filtered by status/version)
router.get('/:id/annotations', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let anns = await query('annotations', a => String(a.project_id) === String(req.params.id));

  // Filter by status
  if (req.query.status) {
    anns = anns.filter(a => a.status === req.query.status);
  }

  // Filter by version
  if (req.query.version) {
    anns = anns.filter(a => String(a.version) === String(req.query.version));
  }

  // Sort by created_at
  anns.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  res.json(anns);
});

// Create annotation
router.post('/:id/annotations', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { x, y, page, author, content, element_info, doc_x, doc_y } = req.body;

  if (x === undefined || y === undefined || !content) {
    return res.status(400).json({ error: 'x, y, and content are required' });
  }

  const ann = await insert('annotations', {
    project_id: req.params.id,
    version: project.version || 1,
    x: parseFloat(x),
    y: parseFloat(y),
    doc_x: doc_x !== undefined ? parseFloat(doc_x) : null,
    doc_y: doc_y !== undefined ? parseFloat(doc_y) : null,
    page: page || 'index.html',
    author: author || 'Anonymous',
    content,
    element_info: element_info || null,
    status: 'open'
  });

  res.status(201).json(ann);
});

// Update annotation (e.g., resolve/reopen) — owner operation: only the
// project owner can resolve/reopen or edit annotation content, preventing
// unauthorized reviewers from tampering with others' annotations.
router.put('/:id/annotations/:annId', requireOwnerAuth, async (req, res) => {
  const ann = await getById('annotations', req.params.annId);
  if (!ann || String(ann.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Annotation not found' });
  }

  const { status, content } = req.body;
  const patch = {};
  if (status) patch.status = status;
  if (content !== undefined) patch.content = content;

  const updated = await update('annotations', req.params.annId, patch);
  res.json(updated);
});

// Delete annotation — owner operation: prevents unauthorized deletion of
// other reviewers' annotations (IDOR fix).
router.delete('/:id/annotations/:annId', requireOwnerAuth, async (req, res) => {
  const ann = await getById('annotations', req.params.annId);
  if (!ann || String(ann.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Annotation not found' });
  }

  await remove('annotations', req.params.annId);
  res.json({ success: true });
});

export default router;

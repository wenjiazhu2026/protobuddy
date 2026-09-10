import { Router } from 'express';
import { getById, query, insert, update, remove } from '../db.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// 参考 html-annotation-editor-Skill 的四类产品注记：字段说明 / 交互逻辑 /
// 业务规则 / 修改原型。类型用于锚点与列表的视觉区分、导出和 Agent 方案生成。
// 历史注记没有 type 时保持 null（界面显示“未标注类型”），不强行归类。
export const ANNOTATION_TYPES = ['字段说明', '交互逻辑', '业务规则', '修改原型'];

function normalizeType(type) {
  return ANNOTATION_TYPES.includes(type) ? type : null;
}

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

  const { x, y, page, author, content, element_info, doc_x, doc_y, type, scope } = req.body;

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
    type: normalizeType(type),
    // 作用域模型（对应 prototype-annotation 参考实现的 scope 契约）：
    //   page:{page}              —— 页面级批注
    //   modal:{id}/drawer:{id}   —— 弹窗/抽屉内批注（创建时由注入脚本探测）
    // 历史批注没有 scope 时按页面级对待，保持兼容。
    scope: typeof scope === 'string' && scope.trim() ? scope.slice(0, 120) : `page:${page || 'index.html'}`,
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

  const { status, content, type, scope } = req.body;
  const patch = {};
  if (status) patch.status = status;
  if (content !== undefined) patch.content = content;
  if (type !== undefined) patch.type = normalizeType(type);
  if (scope !== undefined) {
    patch.scope = typeof scope === 'string' && scope.trim() ? scope.slice(0, 120) : undefined;
    if (patch.scope === undefined) delete patch.scope;
  }

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

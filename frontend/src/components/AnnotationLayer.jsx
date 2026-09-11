import { useMemo, useState } from 'react';
import { ANNOTATION_TYPES, typeMeta } from '../annotationType.js';

const STATUS_META = {
  open:     { label: '待处理', badge: 'badge-orange', pinClass: '',     order: 0 },
  resolved: { label: '已解决', badge: 'badge-green',  pinClass: 'resolved', order: 1 },
  rejected: { label: '不采纳', badge: 'badge-gray',   pinClass: 'rejected', order: 2 }
};

const FILTERS = [
  { key: 'all',      label: '全部' },
  { key: 'open',     label: '待处理' },
  { key: 'resolved', label: '已解决' },
  { key: 'rejected', label: '不采纳' }
];

// 按注记类型筛选（参考项目四类注记）
const TYPE_FILTERS = [
  { key: 'all', label: '全部类型' },
  ...ANNOTATION_TYPES.map(t => ({ key: t, label: t }))
];

const SORTS = [
  { key: 'default',      label: '默认顺序' },
  { key: 'created_desc', label: '时间倒序' },
  { key: 'created_asc',  label: '时间正序' },
  { key: 'status',       label: '状态排序' }
];

/**
 * Escape and quote a CSV cell value.
 */
function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function formatTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sanitizeFileName(name) {
  return String(name || 'project').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportAsJson(annotations, meta) {
  const payload = {
    exportedAt: new Date().toISOString(),
    filter: meta.filter,
    sort: meta.sort,
    total: annotations.length,
    annotations: annotations.map(a => ({
      id: a.id,
      type: a.type || null,
      scope: a.scope || `page:${a.page || 'index.html'}`,
      content: a.content,
      status: a.status,
      author: a.author,
      page: a.page,
      x: a.x,
      y: a.y,
      created_at: a.created_at,
      element_info: a.element_info || null
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const filterLabel = FILTERS.find(f => f.key === meta.filter)?.label || meta.filter;
  const sortLabel = SORTS.find(s => s.key === meta.sort)?.label || meta.sort;
  const filename = `批注_${sanitizeFileName(meta.projectName)}_${filterLabel}_${sortLabel}_${formatTimestamp()}.json`;
  triggerDownload(blob, filename);
}

function exportAsCsv(annotations, meta) {
  const headers = ['id', 'type', 'scope', 'content', 'status', 'author', 'page', 'x', 'y', 'created_at', 'element_info'];
  const rows = annotations.map(a => [
    a.id,
    a.type || '',
    a.scope || `page:${a.page || 'index.html'}`,
    a.content,
    a.status,
    a.author,
    a.page,
    a.x,
    a.y,
    a.created_at,
    a.element_info ? JSON.stringify(a.element_info) : ''
  ]);
  const lines = [headers, ...rows].map(r => r.map(csvCell).join(','));
  // UTF-8 BOM so Excel opens Chinese correctly on Windows.
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const filterLabel = FILTERS.find(f => f.key === meta.filter)?.label || meta.filter;
  const sortLabel = SORTS.find(s => s.key === meta.sort)?.label || meta.sort;
  const filename = `批注_${sanitizeFileName(meta.projectName)}_${filterLabel}_${sortLabel}_${formatTimestamp()}.csv`;
  triggerDownload(blob, filename);
}

/**
 * AnnotationLayer - panel showing all annotations for the current version.
 * Supports marking annotations as resolved (已解决) or rejected (不采纳),
 * filtering / sorting, and exporting the currently visible list.
 */
export default function AnnotationLayer({
  annotations,
  onResolve,
  onReject,
  onReopen,
  onDelete,
  onEdit,
  onGeneratePlan,
  activeId,
  onActive,
  onPageTagClick,
  generating,
  projectName,
  isOpen = true,
  onToggle
}) {
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sort, setSort] = useState('default');
  const [exportFormat, setExportFormat] = useState('json');
  // 行内编辑态：editing = { id, content, type }；保存走 onEdit（owner 鉴权）。
  const [editing, setEditing] = useState(null);

  const countBy = (s) => annotations.filter(a => a.status === s).length;
  const openCount = countBy('open');
  const resolvedCount = countBy('resolved');
  const rejectedCount = countBy('rejected');

  const filtered = useMemo(() => {
    let list = annotations.filter(a => {
      if (filter !== 'all' && a.status !== filter) return false;
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      return true;
    });
    list = [...list];
    if (sort === 'created_desc') {
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (sort === 'created_asc') {
      list.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } else if (sort === 'status') {
      list.sort((a, b) => {
        const orderA = (STATUS_META[a.status] || STATUS_META.open).order;
        const orderB = (STATUS_META[b.status] || STATUS_META.open).order;
        if (orderA !== orderB) return orderA - orderB;
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      });
    }
    return list;
  }, [annotations, filter, typeFilter, sort]);

  const handleExport = () => {
    const meta = { projectName, filter, sort };
    if (exportFormat === 'csv') {
      exportAsCsv(filtered, meta);
    } else {
      exportAsJson(filtered, meta);
    }
  };

  const beginEdit = (ann) => {
    setEditing({ id: ann.id, content: ann.content || '', type: ann.type || '字段说明' });
  };

  const saveEdit = async (ann) => {
    if (!editing || !editing.content.trim()) return;
    const patch = {
      content: editing.content.trim(),
      type: ANNOTATION_TYPES.includes(editing.type) ? editing.type : ann.type
    };
    const ok = await onEdit?.(ann, patch);
    if (ok) setEditing(null);
  };

  if (!isOpen) {
    return (
      <div className="annotation-panel annotation-panel-collapsed" title="展开批注列表">
        <button
          className="annotation-panel-toggle"
          onClick={() => onToggle?.()}
          aria-label="展开批注列表"
          title="展开批注列表"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="annotation-panel-collapsed-title">批注列表</div>
        <div className="annotation-panel-collapsed-counts">
          {openCount > 0 && <span className="badge badge-orange" title={`待处理 ${openCount}`}>{openCount}</span>}
          {resolvedCount > 0 && <span className="badge badge-green" title={`已解决 ${resolvedCount}`}>{resolvedCount}</span>}
          {rejectedCount > 0 && <span className="badge badge-gray" title={`不采纳 ${rejectedCount}`}>{rejectedCount}</span>}
          {annotations.length === 0 && <span className="badge badge-gray">0</span>}
        </div>
        {openCount > 0 && (
          <button
            className="annotation-panel-toggle-generate"
            onClick={() => onGeneratePlan?.()}
            disabled={generating}
            title="生成修改方案"
            aria-label="生成修改方案"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="annotation-panel">
      <div className="annotation-panel-header">
        <span>批注列表</span>
        <button
          className="annotation-panel-toggle"
          onClick={() => onToggle?.()}
          aria-label="收起批注列表"
          title="收起批注列表"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Status filters */}
      <div className="annotation-filters">
        {FILTERS.map(f => {
          const count = f.key === 'all' ? annotations.length
            : f.key === 'open' ? openCount
            : f.key === 'resolved' ? resolvedCount : rejectedCount;
          return (
            <button
              key={f.key}
              className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {/* 注记类型筛选 */}
      <div className="annotation-filters annotation-filters-type">
        {TYPE_FILTERS.map(f => (
          <button
            key={f.key}
            className={`btn btn-sm ${typeFilter === f.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTypeFilter(f.key)}
          >
            {f.key !== 'all' && (
              <span className="annotation-type-dot" style={{ background: typeMeta(f.key).color }} />
            )}
            {f.label}
          </button>
        ))}
      </div>

      {/* Sort selector */}
      <div className="annotation-sort">
        <label htmlFor="annotation-sort">排序</label>
        <select
          id="annotation-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="annotation-sort-select"
        >
          {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <span className="annotation-sort-count">共 {filtered.length} 条</span>
      </div>

      {/* Scrollable list */}
      <div className="annotation-list">
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 16px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            <div className="empty-state-title">暂无批注</div>
            <div className="empty-state-desc">点击预览区任意位置添加批注</div>
          </div>
        ) : (
          filtered.map((ann, idx) => {
            const meta = STATUS_META[ann.status] || STATUS_META.open;
            return (
              <div
                key={ann.id}
                className={`annotation-item ${activeId === ann.id ? 'active' : ''}`}
                onClick={() => onActive?.(ann)}
              >
                <div className="annotation-item-header">
                  <div className={`annotation-pin-mini ${meta.pinClass}`}>
                    <span>{idx + 1}</span>
                  </div>
                  <span className={`badge ${meta.badge}`}>{meta.label}</span>
                  {ann.type && (
                    <span
                      className="annotation-type-badge"
                      style={{ color: typeMeta(ann.type).color, borderColor: typeMeta(ann.type).color }}
                    >
                      <span className="annotation-type-dot" style={{ background: typeMeta(ann.type).color }} />
                      {typeMeta(ann.type).label}
                    </span>
                  )}
                  <span className="annotation-scope-badge" title={ann.scope || '页面级'}>
                    {ann.scope?.startsWith('modal:')
                      ? `弹窗 · ${ann.scope.slice(6)}`
                      : ann.scope?.startsWith('drawer:')
                        ? `抽屉 · ${ann.scope.slice(7)}`
                        : '页面级'}
                  </span>
                </div>
                <div className="annotation-item-content">
                  {editing?.id === ann.id ? (
                    <div className="annotation-edit-form annotation-edit-form-inline" onClick={(e) => e.stopPropagation()}>
                      <select
                        className="annotation-edit-type"
                        value={editing.type}
                        onChange={(e) => setEditing(ed => ({ ...ed, type: e.target.value }))}
                        aria-label="批注类型"
                      >
                        {ANNOTATION_TYPES.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <textarea
                        className="annotation-edit-textarea"
                        value={editing.content}
                        rows={2}
                        onChange={(e) => setEditing(ed => ({ ...ed, content: e.target.value }))}
                        placeholder="请输入批注内容..."
                      />
                      <div className="annotation-edit-actions">
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditing(null)}>
                          取消
                        </button>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => saveEdit(ann)}
                          disabled={!editing.content.trim()}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {ann.content}
                      {ann.updated_at && ann.updated_at !== ann.created_at && (
                        <span className="annotation-item-modified" title={`修改于 ${new Date(ann.updated_at).toLocaleString('zh-CN')}`}>
                          ✎ 已修改
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="annotation-item-meta">
                  {ann.author} · 位置 ({ann.x}%, {ann.y}%) · {new Date(ann.created_at).toLocaleString('zh-CN')}
                </div>
                {ann.page && ann.page !== 'index.html' && (
                  <button
                    type="button"
                    className="annotation-item-page"
                    title={`跳转到 ${ann.page}`}
                    onClick={(e) => { e.stopPropagation(); onPageTagClick?.(ann.page); }}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <path d="M4 4h16v16H4z" /><path d="M9 2v4M15 2v4M9 12h6M9 16h4" />
                    </svg>
                    {ann.page.split('/').pop()}
                  </button>
                )}
                <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {ann.status === 'open' && (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onResolve?.(ann.id); }}>
                        标记已解决
                      </button>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onReject?.(ann.id); }}>
                        标记不采纳
                      </button>
                    </>
                  )}
                  {(ann.status === 'resolved' || ann.status === 'rejected') && (
                    <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onReopen?.(ann.id); }}>
                      重新打开
                    </button>
                  )}
                  {editing?.id !== ann.id && (
                    <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); beginEdit(ann); }}>
                      ✎ 修改
                    </button>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onDelete?.(ann.id); }} style={{ color: 'var(--red)' }}>
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Fixed bottom action bar */}
      <div className="annotation-panel-footer">
        <button
          className="btn btn-primary"
          style={{ width: '100%', marginBottom: 8 }}
          onClick={onGeneratePlan}
          disabled={generating || openCount === 0}
          title={openCount === 0 ? '没有待处理批注' : '基于待处理批注生成修改方案'}
        >
          {generating ? '正在生成方案...' : `生成修改方案 (${openCount} 条待处理批注)`}
        </button>

        <div className="annotation-export">
          <select
            className="annotation-export-select"
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value)}
            aria-label="导出格式"
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
          <button
            className="btn btn-secondary annotation-export-btn"
            onClick={handleExport}
            disabled={filtered.length === 0}
            title={filtered.length === 0 ? '当前筛选结果为空，无可导出数据' : `导出当前筛选后的 ${filtered.length} 条批注`}
          >
            导出
          </button>
        </div>
      </div>
    </div>
  );
}

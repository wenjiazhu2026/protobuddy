import { useEffect, useRef, useState } from 'react';
import { ANNOTATION_TYPES, typeMeta } from '../annotationType.js';

const STATUS_META = {
  open:     { label: '待处理', badge: 'badge-orange', order: 0 },
  resolved: { label: '已解决', badge: 'badge-green',  order: 1 },
  rejected: { label: '不采纳', badge: 'badge-gray',   order: 2 }
};

function scopeLabel(scope) {
  if (!scope) return '页面级';
  if (scope.startsWith('modal:')) return `弹窗 · ${scope.slice(6)}`;
  if (scope.startsWith('drawer:')) return `抽屉 · ${scope.slice(7)}`;
  return '页面级';
}

/**
 * AnnotationDetailPanel - the right rail of the three-column review mode.
 * Shows the selected annotation's full detail and is the dedicated place to
 * 修改批注 (edit content/type), change status, jump to its page or delete it.
 * Falls back to a slim vertical rail when collapsed (mirrors the list rail).
 */
export default function AnnotationDetailPanel({
  annotation,          // selected annotation or null
  onEdit,              // (ann, { content, type }) => Promise<boolean>
  onResolve,
  onReject,
  onReopen,
  onDelete,
  onNavigatePage,      // (page) => void
  collapsed = false,
  onToggleCollapse
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ content: '', type: '' });
  const [saving, setSaving] = useState(false);
  const taRef = useRef(null);

  // Reset the local draft whenever the selected annotation changes.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    if (annotation) {
      setDraft({ content: annotation.content || '', type: annotation.type || '字段说明' });
    } else {
      setDraft({ content: '', type: '字段说明' });
    }
  }, [annotation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.selectionStart = taRef.current.value.length;
      taRef.current.selectionEnd = taRef.current.value.length;
    }
  }, [editing]);

  const beginEdit = () => {
    if (!annotation) return;
    setDraft({ content: annotation.content || '', type: annotation.type || '字段说明' });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!annotation || !draft.content.trim()) return;
    setSaving(true);
    try {
      const patch = {
        content: draft.content.trim(),
        type: ANNOTATION_TYPES.includes(draft.type) ? draft.type : annotation.type
      };
      const ok = await onEdit?.(annotation, patch);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (annotation) {
      setDraft({ content: annotation.content || '', type: annotation.type || '字段说明' });
    }
    setEditing(false);
    setSaving(false);
  };

  if (collapsed) {
    return (
      <div className="annotation-detail annotation-detail-collapsed" title="展开批注详情">
        <button className="annotation-detail-toggle" onClick={() => onToggleCollapse?.(true)} aria-label="展开批注详情" title="展开批注详情">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <div className="annotation-detail-collapsed-title">批注详情</div>
        {annotation && (
          <div className="annotation-detail-collapsed-counts">
            <span className={`badge ${(STATUS_META[annotation.status] || STATUS_META.open).badge}`}>
              {(STATUS_META[annotation.status] || STATUS_META.open).label}
            </span>
          </div>
        )}
      </div>
    );
  }

  const meta = annotation ? (STATUS_META[annotation.status] || STATUS_META.open) : null;
  const tm = annotation ? typeMeta(annotation.type) : null;
  const modified = annotation && annotation.updated_at && annotation.updated_at !== annotation.created_at;

  return (
    <div className="annotation-detail">
      <div className="annotation-detail-header">
        <span>批注详情</span>
        <button
          className="annotation-detail-toggle"
          onClick={() => onToggleCollapse?.(false)}
          aria-label="收起批注详情"
          title="收起批注详情"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div className="annotation-detail-body">
        {!annotation ? (
          <div className="empty-state" style={{ padding: '40px 16px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 40, height: 40, margin: '0 auto 12px', opacity: 0.4 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <div className="empty-state-title">未选择批注</div>
            <div className="empty-state-desc">在左侧列表或页面上点击一条批注查看详情
            </div>
            <div className="empty-state-desc">在此编辑内容、修改类型或调整处理状态</div>
          </div>
        ) : (
          <>
            {/* 徽章行：类型 / 状态 / 作用域 */}
            <div className="annotation-detail-badges">
              {tm && (
                <span
                  className="annotation-type-badge"
                  style={{ color: tm.color, borderColor: tm.color }}
                >
                  <span className="annotation-type-dot" style={{ background: tm.color }} />
                  {tm.label}
                </span>
              )}
              <span className={`badge ${meta.badge}`}>{meta.label}</span>
              <span className="annotation-scope-badge" title={annotation.scope || '页面级'}>
                {scopeLabel(annotation.scope)}
              </span>
            </div>

            {/* 内容（查看 or 编辑） */}
            <div className="annotation-detail-content">
              {editing ? (
                <div className="annotation-edit-form">
                  <label className="annotation-edit-label">批注类型</label>
                  <select
                    className="annotation-edit-type"
                    value={draft.type}
                    onChange={(e) => setDraft(d => ({ ...d, type: e.target.value }))}
                    aria-label="批注类型"
                  >
                    {ANNOTATION_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <label className="annotation-edit-label">批注内容</label>
                  <textarea
                    ref={taRef}
                    className="annotation-edit-textarea"
                    value={draft.content}
                    rows={4}
                    onChange={(e) => setDraft(d => ({ ...d, content: e.target.value }))}
                    placeholder="请输入批注内容..."
                  />
                  <div className="annotation-edit-actions">
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={cancelEdit}
                      disabled={saving}
                    >
                      取消
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={saveEdit}
                      disabled={saving || !draft.content.trim()}
                    >
                      {saving ? '保存中…' : '保存修改'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="annotation-detail-text">{annotation.content}</div>
                  {modified && (
                    <div className="annotation-detail-modified" title={annotation.updated_at}>
                      ✎ 已修改
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 元信息 */}
            <div className="annotation-detail-meta">
              <div>
                <span className="annotation-detail-meta-label">作者</span>
                <span>{annotation.author || 'Anonymous'}</span>
              </div>
              <div>
                <span className="annotation-detail-meta-label">页面</span>
                <span>{annotation.page || 'index.html'}</span>
                {annotation.page && annotation.page !== 'index.html' && (
                  <button
                    type="button"
                    className="annotation-detail-jump"
                    title={`跳转到 ${annotation.page}`}
                    onClick={() => onNavigatePage?.(annotation.page)}
                  >
                    跳转
                  </button>
                )}
              </div>
              <div>
                <span className="annotation-detail-meta-label">位置</span>
                <span>({annotation.x}%, {annotation.y}%)</span>
              </div>
              <div>
                <span className="annotation-detail-meta-label">创建</span>
                <span>{new Date(annotation.created_at).toLocaleString('zh-CN')}</span>
              </div>
              {modified && (
                <div>
                  <span className="annotation-detail-meta-label">修改</span>
                  <span>{new Date(annotation.updated_at).toLocaleString('zh-CN')}</span>
                </div>
              )}
            </div>

            {/* 操作区 */}
            <div className="annotation-detail-actions">
              {editing ? null : (
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ width: '100%' }}
                  onClick={beginEdit}
                >
                  ✎ 修改批注
                </button>
              )}
              {annotation.status === 'open' && (
                <>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => onResolve?.(annotation.id)}
                  >
                    标记已解决
                  </button>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => onReject?.(annotation.id)}
                  >
                    标记不采纳
                  </button>
                </>
              )}
              {(annotation.status === 'resolved' || annotation.status === 'rejected') && (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => onReopen?.(annotation.id)}
                >
                  重新打开
                </button>
              )}
              <button
                className="btn btn-sm btn-secondary"
                style={{ color: 'var(--red)' }}
                onClick={() => onDelete?.(annotation.id)}
              >
                删除批注
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
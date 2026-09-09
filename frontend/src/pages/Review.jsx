import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import PreviewFrame from '../components/PreviewFrame.jsx';
import AnnotationLayer from '../components/AnnotationLayer.jsx';
import { useToast } from '../components/ToastContext.jsx';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';

export default function Review() {
  const { id } = useParams();
  const navigate = useNavigate();
  const previewRef = useRef(null);
  const [project, setProject] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Whether the in-iframe editor actually booted (acks via __pbEditReady).
  // The outer 保存到项目 button stays disabled until the editor is live.
  const [editorReady, setEditorReady] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [latestPlan, setLatestPlan] = useState(null);
  const [currentPage, setCurrentPage] = useState('index.html');
  const { showToast } = useToast();
  const { guard } = useOwnerAuth();
  const [taskCount, setTaskCount] = useState(null);
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem('protobuddy.review.panel.open') !== 'false'; } catch { return true; }
  });

  // Editor ready/exit reports from the iframe (stable identity so the preview
  // message listener is not re-registered on every render).
  const handleEditStateChange = useCallback((active) => {
    setEditMode(!!active);
    setEditorReady(!!active);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('protobuddy.review.panel.open', String(panelOpen)); } catch {}
  }, [panelOpen]);

  const load = useCallback(async () => {
    try {
      const [p, anns] = await Promise.all([
        api.getProject(id),
        api.listAnnotations(id)
      ]);
      setProject(p);
      setAnnotations(anns);
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Task count badge for the tasks entry (never blocks the review page)
  useEffect(() => {
    api.listTasks(id)
      .then(ts => setTaskCount(ts.length))
      .catch(() => {});
  }, [id]);

  const handleAnnotate = async ({ x, y, content, page, element_info }) => {
    try {
      const ann = await api.createAnnotation(id, {
        x, y,
        page: page || 'index.html',
        author: 'Reviewer',
        content,
        element_info
      });
      setAnnotations([...annotations, ann]);
      setAnnotateMode(false);
      showToast('批注已添加，可在右侧手动生成修改方案');
    } catch (err) {
      showToast('添加批注失败: ' + err.message, 'error');
    }
  };

  const handleResolve = async (annId) => {
    try {
      await guard(id, () => api.updateAnnotation(id, annId, { status: 'resolved' }, getOwnerToken(id)));
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'resolved' } : a));
      showToast('已标记为已解决');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleReject = async (annId) => {
    try {
      await guard(id, () => api.updateAnnotation(id, annId, { status: 'rejected' }, getOwnerToken(id)));
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'rejected' } : a));
      showToast('已标记为不采纳');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleReopen = async (annId) => {
    try {
      await guard(id, () => api.updateAnnotation(id, annId, { status: 'open' }, getOwnerToken(id)));
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'open' } : a));
      showToast('已重新打开');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleDelete = async (annId) => {
    if (!confirm('确定删除此批注？')) return;
    try {
      await guard(id, () => api.deleteAnnotation(id, annId, getOwnerToken(id)));
      setAnnotations(annotations.filter(a => a.id !== annId));
      showToast('批注已删除');
    } catch (err) {
      showToast('删除失败: ' + err.message, 'error');
    }
  };

  /**
   * Visual-edit save: the iframe editor serializes a page back to HTML and
   * posts it here. Writing files is owner-gated (like upload/deploy), so the
   * OwnerAuth guard opens the password dialog when needed. On success the
   * project version bumps and the preview reloads with the edited content.
   */
  const handleEditorSave = useCallback(async (page, html) => {
    try {
      await guard(id, () => api.writeFile(id, page, html, getOwnerToken(id)));
      setProject(p => ({ ...p, version: (p.version || 1) + 1 }));
      setEditMode(false);
      setEditorReady(false);
      showToast(`已保存到项目 · ${page.split('/').pop()}`, 'success');
      return { ok: true };
    } catch (err) {
      if (err && /verification cancelled/i.test(err.message)) {
        return { ok: false, error: '未通过 owner 验证，未保存' };
      }
      showToast('保存失败: ' + err.message, 'error');
      return { ok: false, error: err.message };
    }
  }, [id, guard, showToast]);

  const handleGeneratePlan = async (opts = {}) => {
    if (generating) return;
    setGenerating(true);
    try {
      const plan = await api.generatePlan(id, opts);
      setLatestPlan(plan);
      showToast(`方案已生成: ${plan.changes?.length || 0} 条修改建议 (${plan.method === 'makers' ? 'Makers Models' : '规则引擎'})`);
      navigate(`/project/${id}/plan`);
    } catch (err) {
      // 409: open annotations already covered by an unfinished plan. Offer an
      // explicit force-regenerate instead of silently stacking duplicate plans.
      if (err.code === 'PLAN_ALREADY_EXISTS') {
        if (window.confirm(`${err.message}\n\n是否强制重新生成？（原方案仍保留，可手动驳回）`)) {
          try {
            const plan = await api.generatePlan(id, { force: true });
            setLatestPlan(plan);
            showToast(`方案已强制重新生成: ${plan.changes?.length || 0} 条修改建议`);
            navigate(`/project/${id}/plan`);
            return;
          } catch (err2) {
            showToast('生成方案失败: ' + err2.message, 'error');
            return;
          }
        }
        showToast('已取消：请先在方案页处理已有方案', 'info');
      } else {
        showToast('生成方案失败: ' + err.message, 'error');
      }
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  const hasPreview = project.current_url || project.status === 'uploaded' || project.status === 'deployed';

  return (
    <div className="main-content review-main" style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <Link to={`/project/${id}`} className="back-link">← 返回仪表盘</Link>
          <h1 className="page-title">{project.name} · 评审</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {editMode && (
            <button
              className="btn btn-primary"
              onClick={() => previewRef.current?.saveCurrentPage()}
              disabled={!editorReady}
              title={editorReady
                ? '把当前编辑页的改动写回平台存储（需 owner 密码）'
                : '编辑器正在加载，请稍候…'}
            >
              💾 保存到项目
            </button>
          )}
          <button
            className={`btn ${editMode ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => {
              if (!editMode && annotateMode) setAnnotateMode(false);
              setEditorReady(false);
              setEditMode(!editMode);
            }}
            disabled={!hasPreview || (editMode && !editorReady)}
            title={editMode && !editorReady
              ? '编辑器正在加载，请稍候…'
              : '直接拖拽/双击编辑 HTML 原型，改完点「保存到项目」写回平台存储'}
          >
            {editMode && !editorReady
              ? '⏳ 编辑器加载中…'
              : editMode ? '◉ 编辑模式中' : '🖱 可视化编辑'}
          </button>
          <button
            className={`btn ${annotateMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              if (!annotateMode && editMode) setEditMode(false);
              setAnnotateMode(!annotateMode);
            }}
            disabled={!hasPreview}
          >
            {annotateMode ? '● 点击预览区添加批注（再次点击退出）' : '+ 添加批注'}
          </button>
        </div>
      </div>

      {/* Review layout */}
      <div
        className="review-layout"
        style={{
          '--review-cols': panelOpen ? '1fr 300px' : '1fr 44px',
        }}
      >
        {/* Preview with annotation overlay */}
        <div className="preview-container">
          <div className="preview-toolbar">
            <span style={{ fontWeight: 500, fontSize: 13 }}>原型预览</span>
            <span className="badge badge-blue" title="评审预览从平台存储读取，与 EdgeOne 部署为同源文件">
              平台存储 v{project.version || 1}
            </span>
            {project.deploy_method === 'edgeone' || project.deploy_method === 'edgeone_manual' ? (
              project.current_url && project.current_url.startsWith('http') ? (
                <a
                  className="btn btn-sm btn-secondary"
                  href={project.current_url}
                  target="_blank"
                  rel="noreferrer"
                  title="在 EdgeOne 打开最新部署的版本"
                >
                  最新部署 ↗
                </a>
              ) : null
            ) : null}
            {project.status === 'deploy_failed' && (
              <span className="badge badge-red" title="上次部署未成功，评审预览为平台存储中的文件版本">部署失败</span>
            )}
            {project.current_url && (
              <span className="preview-url">{project.current_url}</span>
            )}
            {editMode && (
              <span className="badge badge-blue" style={{ animation: 'pulse 1.5s infinite', border: '1px solid var(--primary)' }}>
                可视化编辑模式 · 点选/拖拽/双击，⌘S 或「保存到项目」写回平台
              </span>
            )}
            {annotateMode && (
              <span className="badge badge-orange" style={{ animation: 'pulse 1.5s infinite' }}>
                批注模式 · 点击任意位置
              </span>
            )}
            {currentPage !== 'index.html' && (
              <span className="badge badge-blue" title={currentPage}>当前页 · {currentPage.split('/').pop()}</span>
            )}
          </div>
          {hasPreview ? (
            <PreviewFrame
              ref={previewRef}
              projectId={id}
              version={project.version}
              annotateMode={annotateMode}
              editMode={editMode}
              onEditorSave={handleEditorSave}
              onEditStateChange={handleEditStateChange}
              onAnnotate={handleAnnotate}
              annotations={annotations}
              activeAnnotationId={activeAnnotationId}
              onAnnotationClick={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
              onPageChange={setCurrentPage}
            />
          ) : (
            <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 64, height: 64, margin: '0 auto 16px', opacity: 0.4 }}>
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              </svg>
              <div className="empty-state-title">尚未部署原型</div>
              <div className="empty-state-desc">请先在仪表盘上传原型包并部署</div>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate(`/project/${id}`)}>前往仪表盘</button>
            </div>
          )}
        </div>

        {/* Annotation panel */}
        <AnnotationLayer
          annotations={annotations}
          onResolve={handleResolve}
          onReject={handleReject}
          onReopen={handleReopen}
          onDelete={handleDelete}
          onGeneratePlan={handleGeneratePlan}
          activeId={activeAnnotationId}
          onActive={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
          onPageTagClick={(page) => previewRef.current?.navigateTo(page)}
          generating={generating}
          projectName={project.name}
          isOpen={panelOpen}
          onToggle={() => setPanelOpen(o => !o)}
        />
      </div>

      {generating && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-body" style={{ textAlign: 'center', padding: 32 }}>
              <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 16px' }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Agent 正在生成修改方案</div>
              <div className="text-sm-muted">>分析批注内容，生成结构化修改建议...</div>
            </div>
          </div>
        </div>
      )}

      {/* Plan ready floating notification */}
      {latestPlan && !generating && (
        <div className="plan-ready-banner">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="plan-ready-dot" />
              修改方案已生成
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {latestPlan.changes?.length || 0} 条修改建议 · {latestPlan.method === 'makers' ? 'Makers Models' : '规则引擎'} · 生成于 {new Date(latestPlan.created_at).toLocaleTimeString('zh-CN')}
            </div>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => navigate(`/project/${id}/plan`)}>
            查看方案 →
          </button>
          <button
            className="plan-ready-close"
            onClick={() => setLatestPlan(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

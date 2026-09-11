import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import PreviewFrame from '../components/PreviewFrame.jsx';
import AnnotationLayer from '../components/AnnotationLayer.jsx';
import AnnotationDetailPanel from '../components/AnnotationDetailPanel.jsx';
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
  // Stored prototype files; used to build the manual page switcher.
  const [pages, setPages] = useState([]);
  const { showToast } = useToast();
  const { guard } = useOwnerAuth();
  const [taskCount, setTaskCount] = useState(null);
  // Explicit re-sync of the preview iframe. The preview deliberately does NOT
  // rebuild after a visual-edit save (the live DOM already is the stored
  // content — rebuilding would wipe the editor's undo/redo history so that
  // "撤销" can no longer work after a save). Only this counter, bumped by the
  // manual "↻ 刷新" action, forces PreviewFrame to rebuild the iframe.
  const [reloadNonce, setReloadNonce] = useState(0);
  // 批注锚点图层开关（原先是悬浮在预览画面右上角的小胶囊，遮挡原型内容，
  // 现已上移到预览工具栏最右侧）。
  const [pinLayer, setPinLayer] = useState(true);
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem('protobuddy.review.panel.open') !== 'false'; } catch { return true; }
  });

  // ── 视图布局模式：standard（预览 + 右栏批注列表）↔ tri（三栏审阅：左列表 + 中画布 + 右详情）。
  // 两种模式复用同一个 keyed PreviewFrame 实例，切换只移动 DOM 不重建 iframe，
  // 因此当前子页面、锚点定位与可视化编辑会话在来回切换时都不会丢。
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('protobuddy.review.viewMode') === 'tri' ? 'tri' : 'standard'; } catch { return 'standard'; }
  });
  useEffect(() => {
    try { localStorage.setItem('protobuddy.review.viewMode', viewMode); } catch {}
  }, [viewMode]);

  // 三栏审阅的左右栏宽度与收起状态，按项目（镜像参考项目按 prototypeId 记忆的规则）
  // 持久化到 localStorage；恢复时做夹紧，避免窗口变化导致拖出视口。
  const triPrefsKey = `protobuddy.review.tri.${id}`;
  const [triPrefs, setTriPrefs] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(triPrefsKey) || '{}');
      return {
        leftOpen: p.leftOpen !== false,
        leftW: Math.min(560, Math.max(220, Number(p.leftW) || 320)),
        rightOpen: p.rightOpen !== false,
        rightW: Math.min(560, Math.max(240, Number(p.rightW) || 340))
      };
    } catch {
      return { leftOpen: true, leftW: 420, rightOpen: true, rightW: 340 };
    }
  });
  useEffect(() => {
    try { localStorage.setItem(triPrefsKey, JSON.stringify(triPrefs)); } catch {}
  }, [triPrefs, triPrefsKey]);

  // 三栏分隔线拖拽调宽（左栏/右栏各一根）。
  const triGripRef = useRef(null);
  const startTriDrag = useCallback((side) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? triPrefs.leftW : triPrefs.rightW;
    triGripRef.current = { side, startX, startW };
    const onMove = (ev) => {
      const d = triGripRef.current;
      if (!d) return;
      const delta = ev.clientX - d.startX;
      const next = d.startW + (side === 'left' ? delta : -delta);
      if (side === 'left') {
        setTriPrefs(p => ({ ...p, leftOpen: true, leftW: Math.min(560, Math.max(220, next)) }));
      } else {
        setTriPrefs(p => ({ ...p, rightOpen: true, rightW: Math.min(560, Math.max(240, next)) }));
      }
    };
    const onUp = () => {
      triGripRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [triPrefs.leftW, triPrefs.rightW]);

  // ── 原型页面全屏视图 ──
  // 优先原生 Fullscreen API（覆盖浏览器窗口，最“全屏”）；不支持或被拒绝时退化为
  // CSS 固定覆盖层（占满视口、隐藏应用外壳，只保留原型画布）。两种方式都复用
  // 同一个 keyed 预览容器节点，绝不重建 iframe，避免丢失当前页面/编辑状态。
  const previewBoxRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (fullscreen || (document.fullscreenElement && previewBoxRef.current === document.fullscreenElement)) {
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
      setFullscreen(false);
      return;
    }
    const box = previewBoxRef.current;
    if (box && typeof box.requestFullscreen === 'function') {
      try {
        box.requestFullscreen().then(() => {}).catch(() => setFullscreen(true));
      } catch (_) {
        setFullscreen(true);
      }
    } else {
      setFullscreen(true);
    }
  }, [fullscreen]);
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  // CSS 兜底全屏时支持 Esc 退出（原生全屏 Esc 由浏览器处理）。
  useEffect(() => {
    if (!fullscreen || document.fullscreenElement) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

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
      const [p, anns, f] = await Promise.all([
        api.getProject(id),
        api.listAnnotations(id),
        api.listFiles(id).catch(() => [])
      ]);
      setProject(p);
      setAnnotations(anns);
      setPages(f);
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // 页面切换下拉数据源：项目内全部 HTML 页面，index.html 置顶，其余按路径排序。
  const htmlPages = useMemo(() => {
    return pages
      .filter(f => /\.html?$/i.test(f.path || ''))
      .map(f => ({ path: f.path.replace(/^\.\//, ''), label: (f.path || '').replace(/^\.\//, '') }))
      .sort((a, b) => {
        const ai = a.path === 'index.html' ? 0 : 1;
        const bi = b.path === 'index.html' ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return a.label.localeCompare(b.label, 'zh-CN');
      });
  }, [pages]);

  // Task count badge for the tasks entry (never blocks the review page)
  useEffect(() => {
    api.listTasks(id)
      .then(ts => setTaskCount(ts.length))
      .catch(() => {});
  }, [id]);

  const handleAnnotate = async ({ x, y, content, page, element_info, type, scope }) => {
    try {
      const ann = await api.createAnnotation(id, {
        x, y,
        page: page || 'index.html',
        author: 'Reviewer',
        content,
        type: type || '字段说明',
        scope: scope || `page:${page || 'index.html'}`,
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

  // 修改批注（内容 / 类型）。写操作与删除/解决一致，走 owner 权限守卫。
  const handleEditAnnotation = async (ann, patch) => {
    try {
      const updated = await guard(id, () => api.updateAnnotation(id, ann.id, patch, getOwnerToken(id)));
      setAnnotations(prev => prev.map(a => a.id === ann.id ? { ...a, ...patch, updated_at: updated?.updated_at } : a));
      showToast('批注已修改');
      return true;
    } catch (err) {
      showToast('修改失败: ' + err.message, 'error');
      return false;
    }
  };

  /**
   * Visual-edit save: the iframe editor serializes a page back to HTML and
   * posts it here. Writing files is owner-gated (like upload/deploy), so the
   * OwnerAuth guard opens the password dialog when needed.
   *
   * On success the project version bumps for the badge, but the preview is NOT
   * reloaded: the DOM the editor just serialized is exactly the content written
   * to the platform, so a reload would throw away the editor's in-memory
   * undo/redo history and "保存后也无法撤销". Instead the editor session stays
   * alive — the user keeps editing and ⌘Z / ⌘⇧Z still undo redo across the
   * save (including back to the previous saved state; a later save persists it).
   */
  const handleEditorSave = useCallback(async (page, html) => {
    try {
      await guard(id, () => api.writeFile(id, page, html, getOwnerToken(id)));
      setProject(p => ({ ...p, version: (p.version || 1) + 1 }));
      showToast(`已保存到项目 · ${page.split('/').pop()}`, 'success');
      return { ok: true };
    } catch (err) {
      if (err && /verification cancelled/i.test(err.message)) {
        return { ok: false, error: '未通过 owner 验证，未保存' };
      }
      showToast('保存失败: ' + err.message, 'error');
      return { ok: false, error: err.message };
    }
  }, [id, guard, showToast, annotations, previewRef]);

  // 只有类型为「修改原型」的待处理批注参与方案生成；同时把每条批注锚点当前
  // 对应的 DOM 元素实时探测出来，随请求交给后端（大模型 / 规则生成器拿它
  // 精确定位 old_code 片段）。探测失败则回退为空对象（后端用历史 element_info）。
  const collectPlanElements = async () => {
    let elements = {};
    try {
      const planAnns = annotations.filter(a => a.status === 'open' && a.type === '修改原型');
      if (planAnns.length > 0 && previewRef.current?.resolveElementsForPlan) {
        elements = (await previewRef.current.resolveElementsForPlan(planAnns)) || {};
      }
    } catch (err) {
      console.warn('[review] resolveElementsForPlan skipped:', err?.message || err);
    }
    return elements;
  };

  const handleGeneratePlan = async (opts = {}) => {
    if (generating) return;
    setGenerating(true);
    try {
      const elements = await collectPlanElements();
      const plan = await api.generatePlan(id, { ...opts, elements });
      setLatestPlan(plan);
      showToast(`方案已生成: ${plan.changes?.length || 0} 条修改建议 (${plan.method === 'makers' ? 'Makers Models' : '规则引擎'})`);
      navigate(`/project/${id}/plan`);
    } catch (err) {
      // 409: open annotations already covered by an unfinished plan. Offer an
      // explicit force-regenerate instead of silently stacking duplicate plans.
      if (err.code === 'PLAN_ALREADY_EXISTS') {
        if (window.confirm(`${err.message}\n\n是否强制重新生成？（原方案仍保留，可手动驳回）`)) {
          try {
            const forceElements = await collectPlanElements();
            const plan = await api.generatePlan(id, { force: true, elements: forceElements });
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

  // 批注列表面板（standard 右栏 / 三栏左栏共用同一份渲染，避免两份重复代码）。
  // isOpen 由所在栏位控制；收起时 AnnotationLayer 自带 44px 窄栏模板。
  const renderAnnotationList = (open, onToggle) => (
    <AnnotationLayer
      annotations={annotations}
      onResolve={handleResolve}
      onReject={handleReject}
      onReopen={handleReopen}
      onDelete={handleDelete}
      onEdit={handleEditAnnotation}
      onGeneratePlan={handleGeneratePlan}
      activeId={activeAnnotationId}
      onActive={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
      onPageTagClick={(page) => previewRef.current?.navigateTo(page)}
      generating={generating}
      projectName={project.name}
      isOpen={open}
      onToggle={() => onToggle(!open)}
    />
  );

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  const hasPreview = project.current_url || project.status === 'uploaded' || project.status === 'deployed';

  return (
    <div className={`main-content review-main ${fullscreen ? 'screen-fullscreen' : ''}`} style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', height: '100%' }}>
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

      {/* Review layout：同一 keyed 容器承载两种模式（standard / tri），共享同一个
          preview-container 节点，切换只重新排列不重建 iframe，当前子页面、锚点
          定位与可视化编辑会话不会随模式切换丢失。 */}
      <div
        key="review-layout"
        className={`review-layout ${viewMode === 'tri' ? 'tri-active' : ''}`}
        style={{
          '--review-cols': panelOpen ? '1fr 300px' : '1fr 44px',
        }}
      >
        {/* 左栏（仅三栏审阅模式）：批注列表，可收起/拖宽 */}
        {viewMode === 'tri' && (
          <div
            key="tri-left"
            className="tri-rail tri-rail-left"
            style={{ width: triPrefs.leftOpen ? triPrefs.leftW : 44 }}
          >
            {renderAnnotationList(triPrefs.leftOpen, (open) => setTriPrefs(p => ({ ...p, leftOpen: open })))}
          </div>
        )}
        {viewMode === 'tri' && (
          <div key="tri-grip-left" className="tri-grip" onPointerDown={startTriDrag('left')} title="拖拽调整列表宽度" aria-hidden="true" />
        )}

        {/* 中栏：原型预览（两种模式共用同一 keyed 节点；全屏时它独占视口） */}
        <div
          key="preview-pane"
          ref={previewBoxRef}
          className="preview-container"
        >
          <div className="preview-toolbar">
            <span style={{ fontWeight: 500, fontSize: 13 }}>原型预览</span>
            <span className="badge badge-blue" title="评审预览固定从平台存储读取（编辑、保存也写平台存储），与 EdgeOne 线上版本无关；线上版本仅在点击重新部署后更新">
              平台存储 v{project.version || 1}
            </span>
            {htmlPages.length > 0 && (
              <label className="page-switcher-label">
                <span>页面</span>
                <select
                  className="page-switcher"
                  value={htmlPages.some(p => p.path === currentPage) ? currentPage : '__other__'}
                  title="当前页 · 可手动切换"
                  aria-label="切换页面"
                  onChange={(e) => {
                    const page = e.target.value;
                    if (page && page !== '__other__' && page !== currentPage) {
                      previewRef.current?.navigateTo(page);
                    }
                  }}
                >
                  {!htmlPages.some(p => p.path === currentPage) && (
                    <option value="__other__">{currentPage.split('/').pop()}</option>
                  )}
                  {htmlPages.map(({ path, label }) => (
                    <option key={path} value={path}>{label}</option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="btn btn-sm btn-secondary"
              title="从平台存储重新加载预览。保存后编辑内容已是最新，无需刷新；仅在需要强制重新同步（如其他端改动过存储）时使用；编辑模式下刷新会丢弃未保存改动"
              onClick={() => {
                if (editMode && !window.confirm('刷新将重新加载预览，未保存的编辑会丢失，确定刷新？')) return;
                setReloadNonce(n => n + 1);
              }}
            >
              ↻ 刷新
            </button>
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
                可视化编辑模式 · 点选/拖拽/双击，⌘S 或「保存到项目」写回平台，保存后仍可 ⌘Z 撤销
              </span>
            )}
            {annotateMode && (
              <span className="badge badge-orange" style={{ animation: 'pulse 1.5s infinite' }}>
                批注模式 · 点击任意位置
              </span>
            )}
            {/* 视图模式切换：常规评审 / 三栏审阅（对应参考项目的浮动/三栏同级分段控件） */}
            <div className="review-mode-switch" role="group" aria-label="评审视图">
              <button
                type="button"
                className={viewMode === 'standard' ? 'active' : ''}
                onClick={() => setViewMode('standard')}
                title="常规评审：左侧原型 + 右侧批注列表"
              >
                常规评审
              </button>
              <button
                type="button"
                className={viewMode === 'tri' ? 'active' : ''}
                onClick={() => setViewMode('tri')}
                title="三栏审阅：左侧批注列表 + 中间原型画布 + 右侧批注详情（左右栏可拖宽/收起）"
              >
                三栏审阅
              </button>
            </div>

            {/* 原型页面全屏视图：整页铺满原型画布，隐藏评审侧栏；再点或 Esc 退出 */}
            <button
              type="button"
              className={`btn btn-sm btn-secondary preview-fullscreen-btn ${fullscreen ? 'active' : ''}`}
              onClick={toggleFullscreen}
              title={fullscreen ? '退出全屏（Esc）' : '全屏预览原型，隐藏评审侧栏'}
              aria-pressed={fullscreen}
            >
              {fullscreen ? (
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              )}
              <span>{fullscreen ? '退出全屏' : '全屏预览'}</span>
            </button>

            {/* 锚点图层开关：悬浮在原型画面上会遮挡内容，改为工具栏最右侧的常驻按钮 */}
            <button
              type="button"
              className={`btn btn-sm btn-secondary preview-pin-toggle ${pinLayer ? 'on' : ''}`}
              onClick={() => setPinLayer(v => !v)}
              title={pinLayer ? '隐藏页面上的批注锚点圆点（批注列表不受影响）' : '在页面上显示批注锚点圆点'}
              aria-pressed={pinLayer}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" />
                <circle cx="12" cy="8" r="3.5" />
              </svg>
              <span>{pinLayer ? '隐藏锚点' : '显示锚点'}</span>
            </button>
          </div>
          {hasPreview ? (
            <PreviewFrame
              ref={previewRef}
              projectId={id}
              reloadNonce={reloadNonce}
              annotateMode={annotateMode}
              editMode={editMode}
              onEditorSave={handleEditorSave}
              onEditStateChange={handleEditStateChange}
              onAnnotate={handleAnnotate}
              annotations={annotations}
              activeAnnotationId={activeAnnotationId}
              onAnnotationClick={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
              onPageChange={setCurrentPage}
              pinLayer={pinLayer}
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

        {/* 右栏：standard 模式渲染右侧批注列表；三栏模式渲染右侧批注详情。
            两个 branch 各自 keyed，切换时不碰撞 preview-container 节点。 */}
        {viewMode === 'tri' && (
          <div key="tri-grip-right" className="tri-grip" onPointerDown={startTriDrag('right')} title="拖拽调整详情宽度" aria-hidden="true" />
        )}
        {viewMode === 'tri' ? (
          <div
            key="tri-right"
            className="tri-rail tri-rail-right"
            style={{ width: triPrefs.rightOpen ? triPrefs.rightW : 44 }}
          >
            <AnnotationDetailPanel
              annotation={annotations.find(a => a.id === activeAnnotationId) || null}
              onEdit={handleEditAnnotation}
              onResolve={handleResolve}
              onReject={handleReject}
              onReopen={handleReopen}
              onDelete={handleDelete}
              onNavigatePage={(page) => previewRef.current?.navigateTo(page)}
              collapsed={!triPrefs.rightOpen}
              onToggleCollapse={(open) => setTriPrefs(p => ({ ...p, rightOpen: open }))}
            />
          </div>
        ) : (
          <div key="list-pane" className="list-pane">
            {renderAnnotationList(panelOpen, (open) => setPanelOpen(open))}
          </div>
        )}
      </div>

      {generating && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-body" style={{ textAlign: 'center', padding: 32 }}>
              <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 16px' }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Agent 正在生成修改方案</div>
              <div className="text-sm-muted">分析批注内容，生成结构化修改建议...</div>
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

import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { API_BASE } from '../api.js';
import { ANNOTATION_TYPES, typeMeta } from '../annotationType.js';

/**
 * Convert a nav pathname (e.g. "/api/projects/1/preview/04-商家控制台.html")
 * to a page identifier relative to the preview root ("04-商家控制台.html").
 * The preview root maps to the entry page ("index.html").
 */
function pageFromPath(raw) {
  let s = decodeURIComponent(String(raw || ''));
  s = s.split('?')[0].split('#')[0];
  const i = s.indexOf('/preview');
  if (i !== -1) s = s.slice(i + '/preview'.length);
  s = s.replace(/^\/+/, '');
  if (!s || s === '') return 'index.html';
  if (s.endsWith('/')) s += 'index.html';
  return s;
}

/** Normalize a stored annotation page field for comparison. */
function normalizePage(p) {
  let s = String(p || 'index.html').replace(/^\.\//, '');
  if (!s) s = 'index.html';
  return s;
}

/**
 * 批注质量门禁（对齐参考项目的低价值/不稳定锚点检查）：
 *  - generic：命中 HTML/BODY 等通用容器 → 视为“未绑定具体元素”，仅记页面坐标；
 *  - noElement：未命中任何元素 → 同上，仅记录坐标；
 *  - undersized：目标元素过小（<2px）→ 保留元素但提示锚点可能不稳定。
 * 返回 { level: 'warn'|'pass'|'fail', message } 或 null（无问题）。
 */
function classifyAnchor(info) {
  if (!info || !info.found) {
    return { level: 'fail', message: '未命中具体元素，仅记录页面坐标' };
  }
  if (info.generic) {
    return { level: 'fail', message: '命中通用容器（页面根级别），批注将按页面坐标记录' };
  }
  if (info.undersized) {
    return { level: 'warn', message: '目标元素过小（<2px），锚点可能不稳定' };
  }
  return null;
}

/**
 * PreviewFrame - renders the prototype in an iframe.
 * The overlay sits ON TOP of the iframe (not inside it) to avoid cross-domain issues.
 * Clicks on the overlay are converted to percentage coordinates.
 *
 * Scroll sync: the backend injects a small script into the prototype HTML that
 * reports iframe scroll position via postMessage. Anchors offset by the scroll
 * delta so they follow the page content as it scrolls (up/down/left/right).
 *
 * Element anchoring: when an annotation is created, the iframe probe also
 * records the DOM element under the click point (tag/id/class/path/rect). On
 * every scroll, the parent asks the iframe for the current bounding rect of
 * that element and repositions the pin so it stays glued to the corresponding
 * content. If the element scrolls out of view, the pin fades out.
 *
 * Document-relative fallback: if element anchoring is unavailable, the pin is
 * positioned using document-relative percentages (docX/docY) reported by the
 * probe script, combined with the current document size and scroll position.
 * This avoids the container-percentage drift that happens when the iframe
 * content is centered, scaled, or has a different aspect ratio than the overlay.
 *
 * Sub-page navigation: the same injected script intercepts relative/same-origin
 * link clicks (keeping them inside the iframe) and reports the current page via
 * {__protoNav}. This component tracks the current page so annotation pins are
 * filtered per page and new annotations record which page they belong to.
 */
function PreviewFrame({ projectId, reloadNonce = 0, annotateMode, onAnnotate, annotations, activeAnnotationId, onAnnotationClick, onPageChange, editMode = false, onEditorSave, onEditStateChange, pinLayer = true }, ref) {
  const containerRef = useRef(null);
  const iframeRef = useRef(null);
  const probeRef = useRef({ nextId: 0, results: {} });
  const pendingQueryRef = useRef(null);
  const rafRef = useRef(null);
  const draftInputRef = useRef(null);
  const editModeRef = useRef(editMode);
  const pendingEditRef = useRef(null);
  // Ack: whether the iframe confirmed the editor became active (__pbEditReady).
  // Used to keep (re)sending the mode message until the iframe acknowledges,
  // so a toggle clicked while the preview is still booting is not silently lost.
  const editAckRef = useRef(false);
  // 当前页面（同步镜像 currentPage）：iframe 内的脚本跳转时用来判断“这次跳转是
  // 用户主动换页，还是原型自身的链接把编辑中的页面顶掉了”。
  const pageRef = useRef('index.html');
  // 本次编辑会话内已经拦截过的意外跳转次数。只拦一次，避免原型是「入口页自动
  // 跳转」的形态时陷入来回横跳。
  const blockedNavRef = useRef(0);

  const [iframeKey, setIframeKey] = useState(0);
  // Unique per component mount: React will recreate the <iframe> element (and
  // therefore its browsing context) on every re-entry into the preview, so the
  // browser cannot restore the previously visited sub-page. Mirrors EdgeOne
  // Makers' default: the preview always opens at the entry document (index).
  const [mountNonce] = useState(() => Math.random().toString(36).slice(2));
  const [scrollPos, setScrollPos] = useState({ x: 0, y: 0 });
  const [docSize, setDocSize] = useState({ width: 1, height: 1 });
  const [currentPage, setCurrentPage] = useState('index.html');
  // Map annotation id -> latest __protoElementPos result for that element
  const [elementPositions, setElementPositions] = useState({});
  // Inline annotation draft (replaces window.prompt)
  const [draft, setDraft] = useState(null);
  const [draftInput, setDraftInput] = useState('');
  const [draftType, setDraftType] = useState('字段说明');
  // 批注模式下悬停目标元素的信息（用于“将锚定到…”提示）
  const [hoverInfo, setHoverInfo] = useState(null);
  const hoverRafRef = useRef(null);
  const hoverPosRef = useRef(null);
  // 锚点图层开关（对应参考项目“圆点显示开关”）：由评审页顶部的预览工具栏持有
  // （pinLayer prop），隐藏时不渲染任何 pin，保留批注模式/元素探测，便于对照
  // 页面原始样式。
  // 当前 iframe 内最高层作用域（modal:{id} / drawer:{id} / null=页面层）。
  // 弹窗打开时只展示弹窗内批注，关闭后自动恢复页面级批注（参考项目“最高作用域”）。
  const [overlayScope, setOverlayScope] = useState(null);
  // 画布缩放（可视化编辑器 → __pbZoom{ k }；缩放时给 iframe 加 transform: scale，
  // 并隐藏外层锚点/高亮层避免与缩放后的画布错位）。
  const [visualZoom, setVisualZoom] = useState(1);
  // 草稿点击位置的元素探测结果（异步返回后展示“将绑定…”/质量提示）
  const [draftElement, setDraftElement] = useState(null);

  // Construct preview URL - use relative path so it works in both dev and prod
  const previewUrl = `${API_BASE}/projects/${projectId}/preview/`;

  // Security: only accept postMessage from the same origin (the preview iframe
  // is same-origin, served by this app). Prevents malicious pages loaded into
  // the iframe from sending spoofed scroll/position data.
  const allowedOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  // Rebuild the iframe when reloadNonce changes (explicit external re-sync).
  // The stored content version is deliberately NOT a reload trigger: after a
  // visual-edit save the live DOM *is* the content just written to the
  // platform, so reloading would discard the editor's in-memory undo/redo
  // history — undo (⌘Z)/redo (⌘⇧Z) must keep working after a save. Callers
  // bump reloadNonce when a real re-fetch of the iframe document is desired
  // (e.g. the explicit "↻ 刷新" action after external changes).
  useEffect(() => {
    setIframeKey(k => k + 1);
    setScrollPos({ x: 0, y: 0 });
    setDocSize({ width: 1, height: 1 });
    setCurrentPage('index.html');
    pageRef.current = 'index.html';
    blockedNavRef.current = 0;
    setElementPositions({});
    setDraft(null);
    setDraftInput('');
  }, [reloadNonce]);

  // ----- Visual editor (可视化编辑) support -----
  // Keep a ref so the postMessage listener always sees the latest value without
  // re-registering listeners on every toggle.
  useEffect(() => { editModeRef.current = editMode; }, [editMode]);

  // Ask the iframe to turn the visual editor on/off.
  const sendEditMode = useCallback((delay = 0) => {
    const fire = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage({ __pbEdit: { v: editModeRef.current ? 1 : 0 } }, allowedOrigin);
      } catch (_) {
        // iframe not ready / navigated; ignore
      }
    };
    if (delay > 0) {
      const t = setTimeout(fire, delay);
      if (pendingEditRef.current) clearTimeout(pendingEditRef.current);
      pendingEditRef.current = t;
    } else {
      fire();
    }
  }, [allowedOrigin]);

  // Turn the editor on when the toggle flips, and re-apply it after a rebuild
  // (reloadNonce change) or a sub-page navigation (each document gets a fresh
  // bootstrap, so the mode message must be re-sent).
  useEffect(() => {
    sendEditMode(0);
  }, [editMode, sendEditMode]);

  // Reliability: after toggling edit mode, keep (re)sending the mode message
  // until the iframe acks with __pbEditReady. Otherwise a click that lands
  // while the preview document (or the editor's module scripts) is still
  // loading is lost and the mode only seems to "take" on a second click.
  useEffect(() => {
    if (!editMode) {
      editAckRef.current = false;
      return;
    }
    editAckRef.current = false;
    // 每次进入编辑模式都重新给一次「阻止跳转」的兜底机会
    blockedNavRef.current = 0;
    sendEditMode(0);
    const iv = setInterval(() => {
      if (editAckRef.current) {
        clearInterval(iv);
        return;
      }
      sendEditMode(0);
    }, 350);
    const t = setTimeout(() => clearInterval(iv), 15000);
    return () => {
      clearInterval(iv);
      clearTimeout(t);
    };
  }, [editMode, sendEditMode]);

  useEffect(() => {
    if (!editMode) return;
    const t = setTimeout(() => sendEditMode(0), 250);
    return () => clearTimeout(t);
  }, [reloadNonce, editMode, sendEditMode]);

  // Reply to a save request from the editor: hand the serialized HTML to the
  // parent, wait for the owner-gated write, then report the result back.
  const handleEditorSave = useCallback((page, html) => {
    const win = iframeRef.current?.contentWindow;
    return Promise.resolve(onEditorSave && onEditorSave(page, html))
      .then(res => {
        const ok = !!(res && res.ok);
        const error = (res && res.error) || '';
        try { win?.postMessage({ __pbSaveRes: { page, ok, error } }, allowedOrigin); } catch (_) {}
        return ok;
      })
      .catch(err => {
        try { win?.postMessage({ __pbSaveRes: { page, ok: false, error: err?.message || '保存失败' } }, '*'); } catch (_) {}
        return false;
      });
  }, [onEditorSave, allowedOrigin]);

  // Only show pins for annotations on the currently displayed page.
  // 作用域联动：iframe 内有弹窗/抽屉打开（overlayScope 非空）时，只显示该层的
  // 批注；关闭后恢复页面级批注（历史批注无 scope 按页面级处理，此时隐藏）。
  const visibleAnnotations = useMemo(() => {
    const onPage = annotations.filter(a => normalizePage(a.page) === currentPage);
    if (!overlayScope) return onPage;
    return onPage.filter(a => a.scope === overlayScope);
  }, [annotations, currentPage, overlayScope]);

  const visibleAnnotationIds = useMemo(() => {
    return visibleAnnotations.map(a => a.id).join(',');
  }, [visibleAnnotations]);

  // Ask the iframe for the current position of every anchored annotation.
  const queryElementPositions = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;

    const targets = visibleAnnotations
      .filter(ann => (ann.element_info?.found && ann.element_info?.path) || ann.content)
      .map(ann => ({
        __protoQuery: 1,
        id: ann.id,
        elementId: ann.element_info?.elementId || ann.element_info?.id || '',
        path: ann.element_info?.path || '',
        // Scope resolution to the modal the annotation was made in, so a
        // same-shaped element in another level/layer is never matched.
        modalId: ann.element_info?.modalId || '',
        scope: ann.scope || `page:${currentPage}`,
        // For old annotations without element_info, try to locate the element by
        // extracting a short keyword from the annotation content.
        text: (ann.element_info?.text || ann.content || '').slice(0, 120)
      }));

    if (targets.length === 0) return;

    targets.forEach(t => {
      try {
        win.postMessage(t, allowedOrigin);
      } catch (_) {
        // iframe may have navigated away; ignore
      }
    });
  }, [visibleAnnotations, allowedOrigin]);

  // Throttle element position queries so rapid scroll events don't flood the iframe.
  const scheduleElementQuery = useCallback(() => {
    if (pendingQueryRef.current) return;
    pendingQueryRef.current = setTimeout(() => {
      pendingQueryRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        queryElementPositions();
        rafRef.current = null;
      });
    }, 100);
  }, [queryElementPositions]);

  // Listen for scroll position reports, page-navigation reports, element
  // probe responses, and element position query responses from the iframe.
  const handleScrollMessage = useCallback((e) => {
    // Security: reject messages from unexpected origins. The preview iframe
    // is same-origin; any other origin is either a cross-origin page that
    // somehow got loaded into the iframe or an attacker.
    if (allowedOrigin && e.origin !== allowedOrigin) return;
    const d = e.data;
    if (!d) return;
    if (d.__protoScroll) {
      setScrollPos({
        x: typeof d.x === 'number' ? d.x : 0,
        y: typeof d.y === 'number' ? d.y : 0
      });
      if (typeof d.docWidth === 'number' && typeof d.docHeight === 'number') {
        setDocSize({ width: d.docWidth, height: d.docHeight });
      }
      // Re-anchor pins after scrolling. The iframe reports scroll position
      // frequently, so throttle the DOM queries.
      scheduleElementQuery();
    } else if (d.__protoNav) {
      const page = pageFromPath(d.path);
      // 编辑模式下原型自身的链接/脚本不许把 iframe 拽走：页面上的点击已被编辑器
      // 守卫与注入的链接拦截器挡下，这里兜住其它路径（原型自定义的捕获监听、
      // location.href 赋值等），把页面拉回正在编辑的这一页。只兜一次，避免入口页
      // 自动跳转这类原型导致来回横跳。
      if (editModeRef.current && editAckRef.current
        && page !== pageRef.current && blockedNavRef.current < 1) {
        blockedNavRef.current += 1;
        const back = pageRef.current;
        const encodedBack = back.split('/').map(encodeURIComponent).join('/');
        const backSrc = back === 'index.html' ? previewUrl : `${previewUrl}${encodedBack}`;
        console.warn('[ProtoBuddy] 编辑模式已阻止页面跳转：', page, '→ 回到', back);
        // iframe 自行跳走后 src 属性仍是原值（属性不随文档跳转变化），因此不能靠
        // 比较 src 判断，必须对 contentWindow 做一次 replace 把它拉回来。
        try {
          iframeRef.current?.contentWindow?.location.replace(backSrc);
        } catch (_) {
          if (iframeRef.current) iframeRef.current.src = backSrc;
        }
        sendEditMode(300);
        return;
      }
      pageRef.current = page;
      setCurrentPage(page);
      // New page starts at scroll 0; discard stale offset and positions
      setScrollPos({ x: 0, y: 0 });
      setDocSize({ width: 1, height: 1 });
      setElementPositions({});
      setVisualZoom(1); // 切页后回到 100%（画布缩放只属于当前页）
      setDraft(null);
      setDraftInput('');
      onPageChange?.(page);
      scheduleElementQuery();
      // A fresh sub-page document carries a fresh editor bootstrap, so re-apply
      // the current editor mode after it has had time to load.
      if (editModeRef.current) sendEditMode(300);
    } else if (d.__protoElement) {
      // store element probe result keyed by request id
      probeRef.current.results[d.id] = d;
    } else if (d.__protoElementPos) {
      // store latest bounding rect for this annotation's anchor element
      setElementPositions(prev => ({ ...prev, [d.id]: d.found ? d : null }));
    } else if (d.__protoHoverInfo) {
      // 批注模式下悬停命中目标元素的反馈，用于“将锚定到…”提示
      setHoverInfo(d.found ? { tag: d.tag, id: d.id, text: d.text } : null);
    } else if (d.__protoScopeState) {
      // iframe 内最高层弹窗作用域变化（打开/关闭弹窗或抽屉）
      setOverlayScope(d.scope || null);
    } else if (d.__pbEditReady) {
      // Visual editor became active/ready inside the iframe -> inform parent.
      // Important: while the user has asked edit mode ON (editModeRef true) we
      // only ever move TO active — a premature "false" ack (e.g. the parallel
      // module load still finishing) must not flip the mode off and force a
      // needless second click. Exit is signalled by the explicit __pbEditExit.
      editAckRef.current = !!d.active;
      if (!d.active && editModeRef.current) return;
      onEditStateChange?.(!!d.active);
    } else if (d.__pbEditExit) {
      // User pressed the in-page "退出" button; parent should resync its toggle
      onEditStateChange?.(false);
    } else if (d.__pbSave) {
      // Editor saved a page: hand it to the parent; the reply guarantees a
      // __pbSaveRes is always sent back (the iframe is waiting on it).
      const inner = d.__pbSave || {};
      const page = String(inner.page || 'index.html');
      const html = String(inner.html || '');
      if (!editModeRef.current) {
        try {
          iframeRef.current?.contentWindow?.postMessage({ __pbSaveRes: { page, ok: false, error: '编辑模式已关闭' } }, allowedOrigin);
        } catch (_) {}
      } else if (!html) {
        try {
          iframeRef.current?.contentWindow?.postMessage({ __pbSaveRes: { page, ok: false, error: '内容为空' } }, allowedOrigin);
        } catch (_) {}
      } else {
        handleEditorSave(page, html);
      }
    } else if (typeof d.__pbZoom === 'number') {
      // 可视化编辑器请求缩放：对 iframe 应用 transform: scale（缩放时外层不
      // 改布局，编辑器 UI / 高亮都在 iframe 内随画布一起缩放）。
      const k = Number.isFinite(d.k) ? Math.min(3, Math.max(0.4, d.k)) : 1;
      setVisualZoom(k);
    } else if (d.__pbZoomFit) {
      // 适应窗口：以当前外层容器尺寸计算缩放，并回执给编辑器（用于工具栏 % 显示）。
      try {
        const win = iframeRef.current?.contentWindow;
        const doc = win?.document;
        const wrap = containerRef.current;
        if (doc && wrap) {
          const de = doc.scrollingElement || doc.documentElement;
          const cw = wrap.clientWidth || 1, ch = wrap.clientHeight || 1;
          const sw = Math.max(de.scrollWidth, doc.body?.scrollWidth || 0, 1);
          const sh = Math.max(de.scrollHeight, doc.body?.scrollHeight || 0, 1);
          const finalK = Math.min(2, Math.max(0.4, Math.min(1, Math.min(cw / sw, ch / sh))));
          setVisualZoom(finalK);
          win?.postMessage({ __pbZoomRes: { k: finalK } }, allowedOrigin);
        }
      } catch (_) {}
    }
  }, [onPageChange, scheduleElementQuery, allowedOrigin, sendEditMode, handleEditorSave, onEditStateChange, previewUrl]);

  useEffect(() => {
    window.addEventListener('message', handleScrollMessage);
    return () => window.removeEventListener('message', handleScrollMessage);
  }, [handleScrollMessage]);

  // 批注模式下的目标元素悬停反馈：向 iframe 发送 __protoHighlight，iframe 内
  // 用虚线框标出当前命中的元素；移出预览或退出批注模式时清除。让作者一眼看
  // 清锚点将落在哪个区域（对应参考项目“手动选择目标区域”的交互）。
  useEffect(() => {
    const container = containerRef.current;
    if (!annotateMode || editMode) {
      hoverPosRef.current = null;
      setHoverInfo(null);
      if (containerRef.current) {
        try {
          iframeRef.current?.contentWindow?.postMessage({ __protoHoverClear: 1 }, allowedOrigin);
        } catch (_) {}
      }
      return;
    }
    if (!container) return;
    const fire = () => {
      const pos = hoverPosRef.current;
      if (!pos) return;
      if (hoverRafRef.current) return;
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null;
        try {
          iframeRef.current?.contentWindow?.postMessage(
            { __protoHighlight: 1, x: pos.x, y: pos.y },
            allowedOrigin
          );
        } catch (_) {}
      });
    };
    const onMove = (e) => {
      const rect = container.getBoundingClientRect();
      hoverPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      fire();
    };
    const onLeave = () => {
      hoverPosRef.current = null;
      setHoverInfo(null);
      try {
        iframeRef.current?.contentWindow?.postMessage({ __protoHoverClear: 1 }, allowedOrigin);
      } catch (_) {}
    };
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    };
  }, [annotateMode, editMode, allowedOrigin]);

  // 单击列表/锚点激活某条批注时，让 iframe 滚动并闪烁高亮其目标元素，方便
  // 评审者对照“批注说的是页面上哪一块”。仅当批注属于当前页面时触发。
  useEffect(() => {
    if (!activeAnnotationId) return;
    const ann = annotations.find(a => a.id === activeAnnotationId);
    if (!ann || normalizePage(ann.page) !== currentPage) return;
    const t = setTimeout(() => {
      try {
        iframeRef.current?.contentWindow?.postMessage({
          __protoReveal: 1,
          id: ann.id,
          elementId: ann.element_info?.elementId || ann.element_info?.id || null,
          path: ann.element_info?.path || null,
          text: ann.element_info?.text || null,
          modalId: ann.element_info?.modalId || null,
          scope: ann.scope || `page:${currentPage}`
        }, allowedOrigin);
      } catch (_) {}
    }, 350);
    return () => clearTimeout(t);
  }, [activeAnnotationId, currentPage, annotations, allowedOrigin]);

  // When the page or the visible annotation list changes, refresh element positions
  // once the new iframe page has had time to render.
  useEffect(() => {
    const t = setTimeout(() => scheduleElementQuery(), 300);
    return () => clearTimeout(t);
  }, [currentPage, visibleAnnotationIds, scheduleElementQuery]);

  // Ask the iframe for the current top overlay scope right after a fresh
  // document loads (sub-page navigation / reload). The iframe also broadcasts
  // __protoScopeState live on overlay open/close via its MutationObserver, so
  // this is only a one-time polling fallback.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        iframeRef.current?.contentWindow?.postMessage({ __protoScopeNow: 1 }, allowedOrigin);
      } catch (_) {}
    }, 350);
    return () => clearTimeout(t);
  }, [currentPage, reloadNonce, allowedOrigin]);

  // Focus the inline input when a draft appears.
  useEffect(() => {
    if (draft && draftInputRef.current) {
      draftInputRef.current.focus();
    }
  }, [draft]);

  // Expose imperative navigation so the annotation panel can jump to a page tag.
  useImperativeHandle(ref, () => ({
    navigateTo: (page) => {
      const target = normalizePage(page);
      const iframe = iframeRef.current;
      if (!iframe) return;
      // Encode each path segment individually so that '/' stays a path
      // separator. encodeURIComponent('merchant/m-stores.html') would produce
      // 'merchant%2Fm-stores.html', which makes some browsers resolve relative
      // resource URLs (e.g. ../shared/common.css) against the wrong base path,
      // causing CSS to fail to load.
      const encodedTarget = target.split('/').map(encodeURIComponent).join('/');
      const nextSrc = target === 'index.html'
        ? previewUrl
        : `${previewUrl}${encodedTarget}`;
      if (iframe.src !== nextSrc) {
        iframe.src = nextSrc;
        // Optimistically update currentPage; __protoNav will correct it once loaded.
        setCurrentPage(target);
        pageRef.current = target;
        setScrollPos({ x: 0, y: 0 });
        setDocSize({ width: 1, height: 1 });
        setElementPositions({});
        setDraft(null);
        setDraftInput('');
        onPageChange?.(target);
        // Keep the editor active across sub-page navigations.
        if (editModeRef.current) sendEditMode(300);
      }
    },
    // Ask the in-iframe editor to serialize+save the current page. The editor
    // replies through its normal __pbSave flow (owner-gated by the parent).
    saveCurrentPage: () => {
      const iframe = iframeRef.current;
      if (!iframe) return false;
      try {
        iframe.contentWindow?.postMessage({ __pbAskSave: 1 }, allowedOrigin);
        return true;
      } catch (_) {
        return false;
      }
    },
    // 方案生成时的实时元素解析：对「当前页面」上的批注，用其锚点 pin 在容器内的
    // 真实坐标再探测一次 DOM，返回 { annId: elementInfo }。探测结果会随方案生成
    // 请求传给后端（覆盖 element_info），确保传给大模型/内置规则生成器的始终是
    // 锚点当前对应的元素——即使元素在原型改版后已变化，或历史批注没存元素。
    resolveElementsForPlan: async (anns) => {
      const container = containerRef.current;
      const iframe = iframeRef.current;
      const results = {};
      if (!container || !iframe?.contentWindow || !anns?.length) return results;
      const cw = container.clientWidth || 1;
      const ch = container.clientHeight || 1;
      const jobs = [];
      for (const ann of anns) {
        if (!ann || (ann.page && normalizePage(ann.page) !== pageRef.current)) continue;
        let pinEl = null;
        try {
          pinEl = container.querySelector(`.annotation-pin[data-annotation-id="${ann.id}"]`);
        } catch (_) { /* ignore */ }
        if (!pinEl) continue;
        const leftPct = parseFloat(pinEl.style.left);
        const topPct = parseFloat(pinEl.style.top);
        if (Number.isNaN(leftPct) || Number.isNaN(topPct)) continue;
        // 锚点已滚出可见区时 pin 是不可见状态，跳过（后端会用历史 element_info）。
        if (pinEl.style.opacity === '0' || pinEl.style.pointerEvents === 'none') continue;
        const probeId = ++probeRef.current.nextId;
        probeRef.current.results[probeId] = null;
        jobs.push({ ann, probeId, x: leftPct / 100 * cw, y: (topPct / 100) * ch });
      }
      for (const j of jobs) {
        try {
          iframe.contentWindow.postMessage(
            { __protoProbe: 1, id: j.probeId, x: j.x, y: j.y },
            allowedOrigin
          );
        } catch (_) { /* iframe 未就绪则跳过 */ continue; }
        const info = await waitForProbe(j.probeId, 450);
        if (info && info.found && info.tagName) {
          results[j.ann.id] = {
            tagName: info.tagName,
            elementId: info.elementId || '',
            className: info.className || '',
            path: info.path || '',
            text: info.text || '',
            isHeading: !!info.isHeading,
            fontSize: info.fontSize || ''
          };
        }
      }
      return results;
    }
  // useImperativeHandle 的依赖里不能引用 waitForProbe（它在下方才声明，
// 渲染期求值会触发 TDZ）；waitForProbe 是稳定 useCallback，闭包直接引用即可。
  }), [previewUrl, onPageChange, sendEditMode, allowedOrigin]);

  // Clean up timers and rAF on unmount
  useEffect(() => {
    return () => {
      if (pendingQueryRef.current) clearTimeout(pendingQueryRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (pendingEditRef.current) clearTimeout(pendingEditRef.current);
    };
  }, []);

  // Wait for the probe result for a given id (max total waitMs).
  const waitForProbe = useCallback((probeId, waitMs = 600) => {
    return new Promise((resolve) => {
      const deadline = Date.now() + waitMs;
      const check = () => {
        const res = probeRef.current.results[probeId];
        if (res) return resolve(res);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(check, 30);
      };
      check();
    });
  }, []);

  // 批注草稿出现后，异步等待元素探测结果（用于草稿卡上的目标/质量提示）。
  useEffect(() => {
    if (!draft) {
      setDraftElement(null);
      return;
    }
    let alive = true;
    (async () => {
      const info = await waitForProbe(draft.probeId, 600);
      if (alive) setDraftElement(info);
    })();
    return () => { alive = false; };
  }, [draft, waitForProbe]);

  const handleClick = (e) => {
    if (!annotateMode || editMode) return;
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const viewportX = e.clientX - rect.left;
    const viewportY = e.clientY - rect.top;

    // Probe the DOM element under the click point via the injected iframe script.
    const probeId = ++probeRef.current.nextId;
    probeRef.current.results[probeId] = null;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { __protoProbe: 1, id: probeId, x: viewportX, y: viewportY },
        allowedOrigin
      );
    } catch (_) {
      // iframe not ready or cross-origin blocked; ignore and fall back to coordinates only
    }

    setDraft({ x, y, viewportX, viewportY, probeId, clientX: e.clientX, clientY: e.clientY });
    setDraftInput('');
  };

  const submitDraft = async () => {
    const content = draftInput.trim();
    if (!content || !draft) {
      setDraft(null);
      setDraftInput('');
      return;
    }

    // Wait a moment for the probe result; the async wait is much more reliable
    // than the old synchronous window.prompt because the event loop stays alive.
    const elementInfoRaw = await waitForProbe(draft.probeId, 500);
    const elementInfo = elementInfoRaw?.found ? elementInfoRaw : null;

    // 质量门禁：generic（通用容器/页面根）或未命中元素时，不写 element_info，
    // 批注退化为页面坐标记录（草稿卡上已用红/黄提示告知作者）。
    const anchorIssue = classifyAnchor(elementInfo);
    const storeElement = (elementInfo && anchorIssue?.level !== 'fail') ? elementInfo : undefined;

    onAnnotate({
      x: Math.round(draft.x * 10) / 10,
      y: Math.round(draft.y * 10) / 10,
      content,
      type: draftType || '字段说明',
      page: currentPage,
      // 作用域：探针回传（modal:{id} / page:{page}），保存到批注记录；
      // 无法探测时退化为页面级。
      scope: elementInfo?.scope || `page:${currentPage}`,
      element_info: storeElement,
      // Persist document-relative coordinates as a robust fallback.
      doc_x: elementInfo?.docX ?? (draft.x / 100),
      doc_y: elementInfo?.docY ?? (draft.y / 100)
    });

    setDraft(null);
    setDraftInput('');
  };

  const cancelDraft = () => {
    setDraft(null);
    setDraftInput('');
  };

  // Compute pin style for an annotation.
  // 1) Prefer element-based anchoring;
  // 2) Fall back to document-relative coordinates (docX/docY) so the pin follows
  //    the content even when the iframe is centered or scaled;
  // 3) Last resort: legacy container-percentage + scroll offset.
  const getPinStyle = (ann) => {
    const container = containerRef.current;
    if (!container) {
      return { left: `${ann.x}%`, top: `${ann.y}%`, transform: 'translate(-50%, -100%)', opacity: 0 };
    }
    const containerRect = container.getBoundingClientRect();

    const pos = elementPositions[ann.id];
    const hasElement = pos?.found;

    if (hasElement) {
      const rect = pos.rect;
      // Prefer the original offset stored at creation time; for old annotations
      // re-anchored by text search, center the pin on the matched element.
      const offsetX = typeof ann.element_info?.offsetX === 'number' ? ann.element_info.offsetX : 0.5;
      const offsetY = typeof ann.element_info?.offsetY === 'number' ? ann.element_info.offsetY : 0.5;

      // Pin tip sits at the anchor point inside the element
      const x = rect.left + rect.width * offsetX;
      const y = rect.top + rect.height * offsetY;

      // 夹紧：目标元素可能被 iframe 视口部分裁剪（对应参考项目的
      // getClippedTargetRect），把锚点钳制到预览容器可见范围内，避免
      // 部分可见元素把 pin 推到 iframe 之外（对应字段仍灰显直到滚回）。
      const margin = 10;
      const cx = Math.min(Math.max(x, margin), containerRect.width - margin);
      const cy = Math.min(Math.max(y, margin), containerRect.height - margin);
      const leftPct = (cx / containerRect.width) * 100;
      const topPct = (cy / containerRect.height) * 100;

      // Hide the pin if its anchor point is well outside the visible viewport
      // (kept in DOM so it can reappear smoothly when scrolled back).
      const buffer = 32;
      const inViewport = y >= -buffer && y <= containerRect.height + buffer
        && x >= -buffer && x <= containerRect.width + buffer;

      return {
        left: `${leftPct}%`,
        top: `${topPct}%`,
        transform: 'translate(-50%, -100%)',
        opacity: inViewport ? 1 : 0,
        pointerEvents: inViewport ? 'auto' : 'none',
        transition: 'opacity 0.15s ease, top 0.1s ease-out, left 0.1s ease-out'
      };
    }

    // Document-relative fallback: map the stored document percentage to the
    // current viewport using the latest reported document size and scroll offset.
    const docW = docSize.width || 1;
    const docH = docSize.height || 1;
    const dx = typeof ann.doc_x === 'number' ? ann.doc_x : (typeof ann.x === 'number' ? ann.x / 100 : 0);
    const dy = typeof ann.doc_y === 'number' ? ann.doc_y : (typeof ann.y === 'number' ? ann.y / 100 : 0);

    // Compute the document pixel position of the anchor point.
    const docPixelX = dx * docW;
    const docPixelY = dy * docH;

    // Convert to viewport pixels (relative to the iframe's viewport origin).
    const viewportX = docPixelX - scrollPos.x;
    const viewportY = docPixelY - scrollPos.y;

    // Convert viewport pixels to overlay percentages.
    const leftPct = (viewportX / containerRect.width) * 100;
    const topPct = (viewportY / containerRect.height) * 100;

    // Keep the pin visible if it is near the viewport, even if the stored
    // container percentage would place it outside due to a resized iframe.
    const buffer = 32;
    const inViewport = viewportY >= -buffer && viewportY <= containerRect.height + buffer
      && viewportX >= -buffer && viewportX <= containerRect.width + buffer;

    const fallbackStyle = {
      left: `${leftPct}%`,
      top: `${topPct}%`,
      transform: 'translate(-50%, -100%)',
      opacity: inViewport ? 1 : 0,
      pointerEvents: inViewport ? 'auto' : 'none',
      transition: 'opacity 0.15s ease, top 0.1s ease-out, left 0.1s ease-out'
    };

    // 已锚定元素的批注只有在元素可见时才显示；元素当前不可见（滚动远离、弹窗
    // 关闭、hidden）时不要用文档坐标兜底冒出来——锚点保持隐藏直到目标回到视野。
    // 只有真正没有 element_info 的历史批注才走上面的坐标兜底。
    if (ann.element_info?.found) {
      return { ...fallbackStyle, opacity: 0, pointerEvents: 'none' };
    }
    return fallbackStyle;
  };

  return (
    <div
      className="preview-iframe-wrapper"
      ref={containerRef}
      onClick={handleClick}
      style={visualZoom !== 1 ? { overflow: 'auto' } : undefined}
    >
      <iframe
        ref={iframeRef}
        key={mountNonce + ':' + iframeKey}
        src={previewUrl}
        className="preview-iframe"
        title="Prototype Preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        onLoad={() => {
          // A fresh iframe document carries a fresh editor bootstrap; re-apply
          // the current mode so a quick toggle right after load is not missed.
          if (editModeRef.current) sendEditMode(0);
        }}
        style={visualZoom !== 1
          ? { transform: `scale(${visualZoom})`, transformOrigin: 'top left', transition: 'transform 0.18s ease' }
          : undefined}
      />
      {/* 锚点图层开关已上移到预览工具栏（Review.jsx 的 .preview-toolbar），
          不再悬浮在原型画面上遮挡内容 */}
      {/* Transparent overlay - sits on top of iframe, same size.
          In visual-edit mode the pointer must reach the iframe (the editor
          handles clicks INSIDE the page), so the overlay never captures.
          画布缩放（visualZoom ≠ 1）时隐藏整层：锚点/高亮/草稿卡都按未缩放坐标
          定位，与缩放后的画布错位，编辑画布期间隐藏更干净。 */}
      <div
        className={`annotation-overlay ${annotateMode && !editMode ? 'mode-annotate' : ''}`}
        style={{
          pointerEvents: annotateMode && !editMode ? 'auto' : 'none',
          opacity: visualZoom !== 1 ? 0 : 1,
          transition: 'opacity 0.15s ease'
        }}
      >
        {pinLayer && visibleAnnotations.map((ann, idx) => {
          const statusClass = ann.status === 'resolved' ? 'resolved' : ann.status === 'rejected' ? 'rejected' : '';
          const pinColor = ann.status === 'resolved' ? 'var(--green)'
          : ann.status === 'rejected' ? 'var(--gray-400)'
          : ANNOTATION_TYPES.includes(ann.type) ? typeMeta(ann.type).color : 'var(--orange)';
          const style = getPinStyle(ann);
          return (
            <div
              key={ann.id}
              data-annotation-id={ann.id}
              className={`annotation-pin ${statusClass} ${activeAnnotationId === ann.id ? 'active' : ''}`}
              style={style}
              onClick={(e) => {
                e.stopPropagation();
                onAnnotationClick?.(ann);
              }}
            >
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z"
                  fill={pinColor}
                />
                <circle cx="12" cy="8" r="3.5" fill="white" />
              </svg>
              <span className="annotation-pin-number" style={{ color: pinColor }}>
                {idx + 1}
              </span>
            </div>
          );
        })}

        {/* Inline annotation input (replaces window.prompt) */}
        {draft && (
          <div
            className="annotation-draft"
            style={{
              position: 'absolute',
              left: `${Math.min(Math.max(draft.x, 8), 92)}%`,
              top: `${Math.min(Math.max(draft.y, 8), 92)}%`,
              // Draw below the anchor point except near the bottom edge, so the
              // box is never clipped by the preview's overflow:hidden.
              transform: draft.y > 85 ? 'translate(-50%, -100%)' : 'translate(-50%, 12px)',
              // Always stay on top (above toasts 2000 / modals 1000 / topbar 100)
              zIndex: 2100,
              width: 260,
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              padding: 10
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 批注类型（参考项目四类注记：字段说明/交互逻辑/业务规则/修改原型） */}
            <div className="annotation-draft-type-row">
              <span className="annotation-draft-type-dot" style={{ background: typeMeta(draftType).color }} />
              <select
                className="annotation-draft-type-select"
                value={draftType}
                onChange={(e) => setDraftType(e.target.value)}
                aria-label="批注类型"
              >
                {ANNOTATION_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            {/* 质量门禁提示：未命中/通用容器/过小元素；元素命中且质量良好时给锚定反馈 */}
            {(() => {
              const issue = draftElement ? classifyAnchor(draftElement) : null;
              if (issue) {
                return (
                  <div className={`annotation-draft-warn ${issue.level}`}>
                    <span>{issue.level === 'fail' ? '注意' : '提示'}</span>
                    {issue.message}
                  </div>
                );
              }
              if (draftElement?.found) {
                return (
                  <div className="annotation-draft-anchor">
                    <span className="annotation-mag-dot" />
                    将锚定到 {draftElement.tagName}{draftElement.elementId ? `#${draftElement.elementId}` : ''}
                    {draftElement.scope && draftElement.scope.startsWith('modal:') ? '（弹窗内）' : draftElement.scope?.startsWith('drawer:') ? '（抽屉内）' : ''}
                  </div>
                );
              }
              return draftElement === null ? null : (
                <div className="annotation-draft-anchor annotation-draft-anchor-probe">正在探测目标元素…</div>
              );
            })()}
            <textarea
              ref={draftInputRef}
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitDraft();
                } else if (e.key === 'Escape') {
                  cancelDraft();
                }
              }}
              placeholder="请输入批注内容..."
              rows={3}
              style={{
                width: '100%',
                resize: 'vertical',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 8,
                fontSize: 13,
                lineHeight: 1.4,
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button className="btn btn-sm btn-secondary" onClick={cancelDraft}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={submitDraft} disabled={!draftInput.trim()}>
                确认
              </button>
            </div>
          </div>
        )}

        {/* 激活批注的目标区域高亮（对应参考项目“打开注记时高亮目标区域”） */}
        {(() => {
          if (visualZoom !== 1) return null; // 缩放画布时外层层不再对齐
          if (!activeAnnotationId) return null;
          const pos = elementPositions[activeAnnotationId];
          if (!pos?.found || !pos?.rect) return null;
          const crect = containerRef.current?.getBoundingClientRect?.();
          if (!crect || crect.width < 1 || crect.height < 1) return null;
          const rect = pos.rect;
          // 夹紧到预览视口（部分可见目标只高亮可见交叠区，避免高亮越出 iframe）
          const vleft = Math.max(0, rect.left);
          const vtop = Math.max(0, rect.top);
          const vright = Math.min(crect.width, rect.left + rect.width);
          const vbottom = Math.min(crect.height, rect.top + rect.height);
          const vw = Math.max(2, vright - vleft);
          const vh = Math.max(2, vbottom - vtop);
          return (
            <div
              className="annotation-active-hl"
              style={{
                position: 'absolute',
                left: `${(vleft / crect.width) * 100}%`,
                top: `${(vtop / crect.height) * 100}%`,
                width: `${(vw / crect.width) * 100}%`,
                height: `${(vh / crect.height) * 100}%`
              }}
            />
          );
        })()}

        {/* 批注模式下悬停目标元素的提示 */}
        {annotateMode && !editMode && visualZoom === 1 && hoverInfo && (
          <div className="annotation-hover-hint">
            <span>将锚定到</span>
            <b>{hoverInfo.tag}{hoverInfo.id ? `#${hoverInfo.id}` : ''}</b>
            {hoverInfo.text ? <em>{hoverInfo.text.slice(0, 36)}</em> : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default forwardRef(PreviewFrame);

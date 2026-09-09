import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { API_BASE } from '../api.js';

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
function PreviewFrame({ projectId, version, annotateMode, onAnnotate, annotations, activeAnnotationId, onAnnotationClick, onPageChange, editMode = false, onEditorSave, onEditStateChange }, ref) {
  const containerRef = useRef(null);
  const iframeRef = useRef(null);
  const probeRef = useRef({ nextId: 0, results: {} });
  const pendingQueryRef = useRef(null);
  const rafRef = useRef(null);
  const draftInputRef = useRef(null);
  const editModeRef = useRef(editMode);
  const pendingEditRef = useRef(null);

  const [iframeKey, setIframeKey] = useState(0);
  const [scrollPos, setScrollPos] = useState({ x: 0, y: 0 });
  const [docSize, setDocSize] = useState({ width: 1, height: 1 });
  const [currentPage, setCurrentPage] = useState('index.html');
  // Map annotation id -> latest __protoElementPos result for that element
  const [elementPositions, setElementPositions] = useState({});
  // Inline annotation draft (replaces window.prompt)
  const [draft, setDraft] = useState(null);
  const [draftInput, setDraftInput] = useState('');

  // Construct preview URL - use relative path so it works in both dev and prod
  const previewUrl = `${API_BASE}/projects/${projectId}/preview/`;

  // Security: only accept postMessage from the same origin (the preview iframe
  // is same-origin, served by this app). Prevents malicious pages loaded into
  // the iframe from sending spoofed scroll/position data.
  const allowedOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  // Reload iframe when version changes, reset scroll offset and cached positions
  useEffect(() => {
    setIframeKey(k => k + 1);
    setScrollPos({ x: 0, y: 0 });
    setDocSize({ width: 1, height: 1 });
    setCurrentPage('index.html');
    setElementPositions({});
    setDraft(null);
    setDraftInput('');
  }, [version]);

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

  // Turn the editor on when the toggle flips, and re-apply it after a reload
  // (version change) or a sub-page navigation (each document gets a fresh
  // bootstrap, so the mode message must be re-sent).
  useEffect(() => {
    sendEditMode(0);
  }, [editMode, sendEditMode]);

  useEffect(() => {
    if (!editMode) return;
    const t = setTimeout(() => sendEditMode(0), 250);
    return () => clearTimeout(t);
  }, [version, editMode, sendEditMode]);

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

  // Only show pins for annotations on the currently displayed page
  const visibleAnnotations = useMemo(() => {
    return annotations.filter(a => normalizePage(a.page) === currentPage);
  }, [annotations, currentPage]);

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
        elementId: ann.element_info?.id || '',
        path: ann.element_info?.path || '',
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
      setCurrentPage(page);
      // New page starts at scroll 0; discard stale offset and positions
      setScrollPos({ x: 0, y: 0 });
      setDocSize({ width: 1, height: 1 });
      setElementPositions({});
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
    } else if (d.__pbEditReady) {
      // Visual editor became active/ready inside the iframe -> inform parent
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
    }
  }, [onPageChange, scheduleElementQuery, allowedOrigin, sendEditMode, handleEditorSave, onEditStateChange]);

  useEffect(() => {
    window.addEventListener('message', handleScrollMessage);
    return () => window.removeEventListener('message', handleScrollMessage);
  }, [handleScrollMessage]);

  // When the page or the visible annotation list changes, refresh element positions
  // once the new iframe page has had time to render.
  useEffect(() => {
    const t = setTimeout(() => scheduleElementQuery(), 300);
    return () => clearTimeout(t);
  }, [currentPage, visibleAnnotationIds, scheduleElementQuery]);

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
        setScrollPos({ x: 0, y: 0 });
        setDocSize({ width: 1, height: 1 });
        setElementPositions({});
        setDraft(null);
        setDraftInput('');
        onPageChange?.(target);
        // Keep the editor active across sub-page navigations.
        if (editModeRef.current) sendEditMode(300);
      }
    }
  }), [previewUrl, onPageChange, sendEditMode]);

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
    const elementInfo = await waitForProbe(draft.probeId, 500);

    onAnnotate({
      x: Math.round(draft.x * 10) / 10,
      y: Math.round(draft.y * 10) / 10,
      content,
      page: currentPage,
      element_info: elementInfo && elementInfo.found ? elementInfo : undefined,
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

      const leftPct = (x / containerRect.width) * 100;
      const topPct = (y / containerRect.height) * 100;

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

    return {
      left: `${leftPct}%`,
      top: `${topPct}%`,
      transform: 'translate(-50%, -100%)',
      opacity: inViewport ? 1 : 0,
      pointerEvents: inViewport ? 'auto' : 'none',
      transition: 'opacity 0.15s ease, top 0.1s ease-out, left 0.1s ease-out'
    };
  };

  return (
    <div className="preview-iframe-wrapper" ref={containerRef} onClick={handleClick}>
      <iframe
        ref={iframeRef}
        key={iframeKey}
        src={previewUrl}
        className="preview-iframe"
        title="Prototype Preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
      {/* Transparent overlay - sits on top of iframe, same size.
          In visual-edit mode the pointer must reach the iframe (the editor
          handles clicks INSIDE the page), so the overlay never captures. */}
      <div
        className={`annotation-overlay ${annotateMode && !editMode ? 'mode-annotate' : ''}`}
        style={{ pointerEvents: annotateMode && !editMode ? 'auto' : 'none' }}
      >
        {visibleAnnotations.map((ann, idx) => {
          const statusClass = ann.status === 'resolved' ? 'resolved' : ann.status === 'rejected' ? 'rejected' : '';
          const pinColor = ann.status === 'resolved' ? 'var(--green)' : ann.status === 'rejected' ? 'var(--gray-400)' : 'var(--orange)';
          const style = getPinStyle(ann);
          return (
            <div
              key={ann.id}
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
      </div>
    </div>
  );
}

export default forwardRef(PreviewFrame);

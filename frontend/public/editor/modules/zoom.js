// zoom.js — 画布缩放（参考 prototype-html-editor 的 Ctrl+滚轮 缩放 / Ctrl+0 适应）
//
// ProtoBuddy 中编辑器运行在项目预览 iframe 内：真正的「缩放」由外层评审应用完成
// （对 <iframe> 元素做 CSS transform: scale），锚点/工具栏等编辑器自身 UI 保持
// 原比例不被放大。本模块负责：
//   - Ctrl/Cmd+滚轮 缩放（阻挡浏览器的默认 Ctrl+滚轮 页面缩放）
//   - 工具栏的 缩小 / 放大 / 适应 按钮
//   - 把新缩放值通过 {__pbZoom:{k}} 告诉外层；外层套完回执 {__pbZoomRes:{k}}
//     用于刷新工具栏的百分比显示；适应视图则发送 {__pbZoomFit:1}，由外层算好
//     缩放比例后回执。
// 独立标签页打开（window.parent === window，无外层应用）时退化为对
// documentElement 应用 CSS zoom，保证缩放仍可用。
window.HVE_Zoom = (function () {
  var MIN = 0.4, MAX = 2.5, STEP = 1.1;
  var cur = 1;
  var active = false;
  var standalone = (function () {
    try { return window.parent === window; } catch (e) { return true; }
  })();

  function round2(k) { return Math.round(k * 100) / 100; }

  function apply(k) {
    k = round2(Math.min(MAX, Math.max(MIN, k)));
    if (k === cur) return;
    cur = k;
    // 工具栏百分比始终跟随（两种模式都要）
    if (window.HVE_Toolbar && typeof window.HVE_Toolbar.updateZoomLabel === 'function') {
      window.HVE_Toolbar.updateZoomLabel();
    }
    if (standalone) {
      // 独立打开：直接用 CSS zoom（Chromium 全量缩放，无需布局改动）
      try { document.documentElement.style.zoom = (cur === 1 ? '' : cur); } catch (e) { /* ignore */ }
      return;
    }
    try {
      window.parent.postMessage({ __pbZoom: 1, k: cur }, '*');
    } catch (e) { /* ignore */ }
  }

  function onWheel(e) {
    if (!active) return;
    // 仅 Ctrl/Cmd+滚轮 触发缩放；普通滚轮保留给原型内部滚动
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var factor = e.deltaY < 0 ? STEP : 1 / STEP;
    apply(cur * factor);
  }

  function onMsg(e) {
    var d = e.data;
    if (!d || !d.__pbZoomRes || typeof d.__pbZoomRes !== 'object') return;
    var k = d.__pbZoomRes.k;
    if (typeof k !== 'number' || isNaN(k)) return;
    cur = round2(Math.min(MAX, Math.max(MIN, k)));
    if (window.HVE_Toolbar && typeof window.HVE_Toolbar.updateZoomLabel === 'function') {
      window.HVE_Toolbar.updateZoomLabel();
    }
  }

  function activate() {
    if (active) return;
    active = true;
    if (!standalone) window.addEventListener('message', onMsg);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.removeEventListener('wheel', onWheel, true);
    if (!standalone) window.removeEventListener('message', onMsg);
    apply(1);
  }

  return {
    activate: activate,
    deactivate: deactivate,
    getK: function () { return cur; },
    zoomIn: function () { apply(cur * STEP); },
    zoomOut: function () { apply(cur / STEP); },
    fit: function () {
      if (standalone) {
        // 独立模式：按视口适配
        var docEl = document.documentElement;
        var sw = Math.max(docEl.scrollWidth, document.body.scrollWidth, 1);
        var sh = Math.max(docEl.scrollHeight, document.body.scrollHeight, 1);
        apply(Math.min(1, window.innerWidth / sw, window.innerHeight / sh));
        return;
      }
      try { window.parent.postMessage({ __pbZoomFit: 1 }, '*'); } catch (e) { /* ignore */ }
    },
    reset: function () { apply(1); }
  };
})();
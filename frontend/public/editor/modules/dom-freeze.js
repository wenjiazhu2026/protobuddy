// dom-freeze.js — 冻结「被编辑过的脚本渲染区域」，避免下次加载被页面脚本重新渲染覆盖
//
// 背景：可视化编辑器改的是「运行时 DOM」。很多原型页自带内联脚本，在 load 时用数据
// 数组重新渲染表格 / 列表（例如 `rankTbody.innerHTML = rows`，并给第一名加「标杆」
// 标签）。于是会出现：
//   用户删掉该标签 → 编辑器把「已删」的 DOM 存回文件 → 下次打开，脚本又跑一遍，
//   `innerHTML = rows` 把整段内容覆盖回来 → 表现为「保存后刷新又恢复」。
//
// 方案：编辑期间用 MutationObserver 记录「被改动区域」最近的带 id 容器（脚本重新
// 渲染时会覆盖它的 innerHTML，但元素本身存活，是稳定的冻结锚点）。保存时把该容器
// 标记为 data-pb-frozen="<编辑后的 innerHTML>"；再往保存结果里注入一小段还原脚本，
// 在页面自身脚本跑完后把冻结容器还原成编辑后的内容。编辑结果即得以保留。
//
// 说明：
//  - `data-pb-frozen` 不是 `data-hve-*`，序列化时不会被剥离，因此会随文件持久化，
//    多次保存可叠加；还原脚本带 data-hve-editor，序列化时被剥离、由保存流程重新注入。
//  - 还原后的容器内容即为评审确认后的「定稿外观」；若页面脚本之后再次渲染该容器
//    （如切换 Top/Bottom），本轮不会再次覆盖（仅在加载后应用若干次），交互仍可用。
window.HVE_DomFreeze = (function () {
  var observer = null;
  var active = false;
  var frozen = []; // 待冻结的容器（去重，保持插入顺序）

  // 结构型容器：页面脚本常用 innerHTML 重绘这些元素（作为无 id 时的兜底锚点）
  var LIST_TAGS = { TBODY: 1, TABLE: 1, UL: 1, OL: 1, DL: 1 };

  function elementOf(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isEditorNode(node) {
    var el = elementOf(node);
    if (!el) return true;
    if (window.HVE_Selector && typeof window.HVE_Selector.isEditorElement === 'function') {
      try { if (window.HVE_Selector.isEditorElement(el)) return true; } catch (e) { /* ignore */ }
    }
    for (var p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.getAttribute && p.getAttribute('data-hve-editor') !== null) return true;
      if (p === document.body) break;
    }
    return false;
  }

  /**
   * 从被改动节点向上找最近的冻结锚点：优先带 id 的容器；否则退化为最近的结构型
   * 列表容器（tbody/table/ul/ol/dl）。都找不到时返回 null（不做冻结，避免误伤大区域）。
   */
  function nearestContainer(node) {
    var el = elementOf(node);
    var listFallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.id && el.id.indexOf('hve-') !== 0) return el;
      if (!listFallback && el.tagName && LIST_TAGS[el.tagName]) listFallback = el;
      el = el.parentElement;
    }
    return listFallback;
  }

  function track(node) {
    if (!node || isEditorNode(node)) return;
    var container = nearestContainer(node);
    if (!container) return;
    if (frozen.indexOf(container) === -1) frozen.push(container);
  }

  function onMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'characterData') { track(m.target); continue; }
      if (m.type === 'childList') {
        track(m.target);
        for (var j = 0; j < m.addedNodes.length; j++) track(m.addedNodes[j]);
        continue;
      }
      if (m.type === 'attributes') {
        // 编辑器的选中/悬停态等标记不视为内容改动
        if (m.attributeName && m.attributeName.indexOf('data-hve-') === 0) continue;
        track(m.target);
      }
    }
  }

  function activate() {
    if (active) return;
    active = true;
    frozen = [];
    try {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
    } catch (e) {
      observer = null;
    }
  }

  function deactivate() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    frozen = [];
  }

  // 剥离编辑器自身注入的 UI 与 data-hve-* 标记，得到「干净」的快照
  function cleanSnapshot(el) {
    var clone;
    try { clone = el.cloneNode(true); } catch (e) { return el.innerHTML; }
    if (window.HVE_Serializer && typeof window.HVE_Serializer.cleanNode === 'function') {
      try { window.HVE_Serializer.cleanNode(clone); } catch (e) { /* ignore */ }
    }
    return clone.innerHTML;
  }

  // 快照大小上限：冻结会把编辑后的 innerHTML 以属性形式再存一份（内容会翻倍），
  // 超大容器（如整页 #app）跳过，避免产物膨胀到写不回去。
  var MAX_SNAPSHOT = 262144; // 256KB

  /**
   * 保存前调用：给记录到的容器打上 data-pb-frozen（值 = 当前即编辑后的 innerHTML）。
   * 返回本次新打标的容器数量。
   */
  function commit() {
    var marked = 0;
    for (var i = 0; i < frozen.length; i++) {
      var el = frozen[i];
      if (!el || !el.isConnected) continue;
      if (el.getAttribute && el.getAttribute('data-hve-editor') !== null) continue;
      var html = cleanSnapshot(el);
      if (html.length > MAX_SNAPSHOT) {
        try { console.warn('[HVE] 跳过冻结（容器内容过大）:', el.tagName + (el.id ? '#' + el.id : ''), html.length + 'B'); } catch (e) { /* ignore */ }
        continue;
      }
      if (el.getAttribute('data-pb-frozen') !== html) {
        el.setAttribute('data-pb-frozen', html);
        marked++;
      }
    }
    return marked;
  }

  function hasFreeze() {
    try { return document.querySelectorAll('[data-pb-frozen]').length > 0; } catch (e) { return false; }
  }

  /**
   * 往序列化结果里注入还原脚本（先清掉旧的一份，保证只有一个）。
   * 页面脚本若在 load 后才异步渲染，这里额外补几次 apply 兜底。
   */
  function embedRestore(html) {
    if (!html) return html;
    if (!hasFreeze() && html.indexOf('data-pb-frozen') === -1) return html;

    var cleaned = html.replace(/<script[^>]*data-pb-freeze-restore[^>]*>[\s\S]*?<\/script>/gi, '');
    // 注意：不加「只执行一次」的全局开关。apply() 本身幂等（内容已等于冻结值就跳过），
    // 而同一 window 内 document 被就地替换（document.write / innerHTML 重设）时全局
    // 开关会残留，导致还原脚本被跳过。去掉开关后，无论新开页面还是就地替换都能生效。
    var script = '<script data-hve-editor="true" data-pb-freeze-restore="1">' +
      '(function(){' +
      'function apply(){var els=document.querySelectorAll("[data-pb-frozen]");' +
      'for(var i=0;i<els.length;i++){var el=els[i],h=el.getAttribute("data-pb-frozen");' +
      'if(h!=null&&el.innerHTML!==h){try{el.innerHTML=h}catch(e){}}}}' +
      'function sched(){apply();setTimeout(apply,60);setTimeout(apply,300);setTimeout(apply,1200);}' +
      'if(document.readyState==="complete")sched();' +
      'else{window.addEventListener("load",sched);' +
      'document.addEventListener("DOMContentLoaded",function(){setTimeout(apply,0)});}' +
      '})();<\/script>';

    if (cleaned.toLowerCase().indexOf('</body>') !== -1) {
      return cleaned.replace(/<\/body>/i, script + '</body>');
    }
    return cleaned + script;
  }

  return {
    activate: activate,
    deactivate: deactivate,
    commit: commit,
    hasFreeze: hasFreeze,
    embedRestore: embedRestore,
    _tracked: function () { return frozen.slice(); }
  };
})();

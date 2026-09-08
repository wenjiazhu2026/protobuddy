// proto-file-manager.js — ProtoBuddy 项目内保存（替换参考项目的本地文件 API）
//
// 与 Chrome 扩展版不同，ProtoBuddy 的编辑器运行在项目预览 iframe 中：
//   - 保存：把序列化后的 HTML 通过 postMessage 交给外层评审应用，
//     由外层携带 owner 授权调用 POST /api/projects/:id/files 写回平台存储，
//     然后通过 {__pbSaveRes} 回执结果。
//   - 独立打开/无外层（window.parent === window）时降级为浏览器下载。
// 粘贴图片等二进制资源没有独立资产目录，统一内联为 base64 data URL。
window.HVE_FileManager = (function () {

  /**
   * 由 iframe 的 location 推导当前页面的相对路径（与 PreviewFrame 的
   * pageFromPath 逻辑一致）：/api/projects/:id/preview/xxx.html -> xxx.html
   */
  function getPage() {
    var p = '';
    try { p = decodeURIComponent(location.pathname || ''); } catch (e) { p = location.pathname || ''; }
    var i = p.indexOf('/preview');
    if (i !== -1) p = p.slice(i + '/preview'.length);
    p = p.replace(/^\/+/, '');
    if (!p || p === '') return 'index.html';
    p = p.split('?')[0].split('#')[0];
    if (p.endsWith('/')) p += 'index.html';
    return p;
  }

  function getFileName() { return getPage().split('/').pop(); }

  /**
   * 保存当前页面 HTML。
   * 1) 有外层应用（同源 iframe）→ postMessage 交给外层写回平台
   * 2) 无外层（新标签页独立打开）→ 降级为浏览器下载
   */
  function saveFile(html) {
    if (window.parent && window.parent !== window) {
      return saveViaParent(html);
    }
    return Promise.resolve(downloadFile(html, getFileName() || 'edited.html'));
  }

  function saveViaParent(html) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(false); // 超时 -> 外层未响应（可能已关闭）
      }, 30000);

      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(!!ok);
      }

      function onMsg(e) {
        var d = e.data;
        if (!d || !d.__pbSaveRes) return;
        if (d.__pbSaveRes.page !== undefined) {
          finish(true);
        }
      }

      window.addEventListener('message', onMsg);
      try {
        window.parent.postMessage({ __pbSave: { page: getPage(), html: html } }, '*');
      } catch (e) {
        finish(false);
      }
    });
  }

  function saveFileAs(html) { return saveFile(html); }

  /** 二进制资源（粘贴图片等）无独立目录，内联为 data URL */
  function saveImageToAssets(dataUrl) { return Promise.resolve(dataUrl); }

  function downloadFile(content, filename) {
    try {
      var blob = new Blob([content], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      return true;
    } catch (e) {
      console.error('[HVE] 下载保存失败:', e);
      return false;
    }
  }

  return {
    openFile: function () { return Promise.resolve(null); },
    saveFile: saveFile,
    saveFileAs: saveFileAs,
    saveImageToAssets: saveImageToAssets,
    hasFileHandle: function () { return false; },
    getFileName: getFileName,
    downloadFile: downloadFile
  };
})();
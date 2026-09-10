import { Router } from 'express';
import AdmZip from 'adm-zip';
import { getById, query, insert, update, remove } from '../db.js';
import { readFileContent, writeFileContent, deleteFile, findEntryPoint, isBinaryFile, listProjectFiles } from '../services/fileStorage.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', eot: 'application/vnd.ms-fontobject', otf: 'font/otf',
  mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', xml: 'text/xml; charset=utf-8'
};
function mimeFor(filePath) {
  const ext = (String(filePath || '').split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

/**
 * Build an RFC 6266 Content-Disposition value.
 *
 * HTTP header values must be Latin-1: passing a non-ASCII filename (very common
 * here — prototype files are named in Chinese) makes Node throw
 * `ERR_INVALID_CHAR: Invalid character in header content ["Content-Disposition"]`,
 * which kills the download with a 500 / broken connection. The real name is
 * carried verbatim in `filename*` (RFC 5987, percent-encoded UTF-8) while the
 * legacy `filename=` parameter gets an ASCII-only fallback.
 */
function contentDisposition(fileName) {
  const name = String(fileName || 'file');
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// List files for a project
router.get('/:id/files', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const files = await query('files', f => String(f.project_id) === String(req.params.id));
  res.json(files);
});

// List ALL file paths from the storage driver itself (source of truth; the
// files table may be incomplete). Used by the external execution CLI
// (scripts/regenerate.js) to pull the full project.
router.get('/:id/storage-files', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const paths = await listProjectFiles(req.params.id);
  res.json({ paths });
});

// Read a single file's content
router.get('/:id/files/*', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.params[0];
  const content = await readFileContent(req.params.id, filePath);
  if (!content) return res.status(404).json({ error: 'File not found' });

  // ?download=1  -> stream the actual bytes with a download disposition
  if (String(req.query.download) === '1') {
    const name = filePath.split('/').pop() || 'file';
    res.set('Content-Disposition', contentDisposition(name));
    res.set('X-Content-Type-Options', 'nosniff');
    if (content.binary) {
      const buf = Buffer.from(content.data, 'base64');
      const type = mimeFor(filePath) || 'application/octet-stream';
      res.type(type);
      return res.send(buf);
    }
    res.type('text/plain; charset=utf-8');
    return res.send(String(content.data));
  }

  res.json({ path: filePath, ...content });
});

// Export every project file as a single ZIP (browser download). Source of
// truth is the storage driver listing, not the DB table.
router.get('/:id/export', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const paths = await listProjectFiles(req.params.id);
  if (!paths.length) return res.status(404).json({ error: 'No files in project' });

  const zip = new AdmZip();
  for (const p of paths) {
    const content = await readFileContent(req.params.id, p);
    if (!content) continue;
    if (content.binary) {
      zip.addFile(p, Buffer.from(content.data, 'base64'));
    } else {
      zip.addFile(p, Buffer.from(String(content.data), 'utf-8'));
    }
  }

  const out = zip.toBuffer();

  // EdgeOne responses are capped near ~6MiB, so a large export ZIP is sliced
  // into parts; the client requests part=<p>&parts=<N> and reassembles.
  const PART_BYTES = 4 * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(out.length / PART_BYTES));
  const reqPart = req.query.part === undefined ? null : parseInt(req.query.part, 10);
  const reqParts = req.query.parts === undefined ? parts : parseInt(req.query.parts, 10);

  if (reqParts !== parts) {
    return res.status(400).json({ error: `Unexpected parts=${reqParts}` });
  }
  if (reqPart !== null) {
    if (!Number.isInteger(reqPart) || reqPart < 0 || reqPart >= parts) {
      return res.status(400).json({ error: `Invalid part=${reqPart}, parts=${parts}` });
    }
    const start = reqPart * PART_BYTES;
    const end = Math.min(out.length, start + PART_BYTES);
    res.set('X-Export-Parts', String(parts));
    res.set('X-Export-Part', String(reqPart));
    res.type('application/octet-stream');
    return res.send(out.subarray(start, end));
  }

  if (out.length > 6.0 * 1024 * 1024) {
    // Nothing below changed; tell the client how many parts to fetch.
    res.set('X-Export-Parts', String(parts));
    return res.status(413).json({ error: 'export-too-large', parts });
  }

  const safe = `${(project.name || 'prototype').replace(/[\/\\:*?"<>|]/g, '_')}_v${project.version || 1}.zip`;
  res.set('Content-Disposition', contentDisposition(safe));
  res.type('application/zip');
  res.send(out);
});

// Write/update a file's content — owner maintenance operation
router.post('/:id/files', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  // writeFileContent returns false when the path is rejected (e.g. traversal
  // guard) — do NOT record or report success for a write that never happened.
  const written = await writeFileContent(req.params.id, filePath, content);
  if (!written) {
    return res.status(400).json({ error: '非法文件路径（拒绝写入）', path: filePath });
  }

  // Upsert file record
  const existing = await query('files', f => String(f.project_id) === String(req.params.id) && f.path === filePath);
  if (existing.length > 0) {
    await update('files', existing[0].id, { version: (existing[0].version || 1) + 1 });
  } else {
    await insert('files', {
      project_id: req.params.id,
      path: filePath,
      version: 1
    });
  }

  // Every stored-content change is a new prototype version (same convention as
  // uploads): keeps the "平台存储 v{n}" badge consistent across reloads.
  await update('projects', req.params.id, {
    version: (project.version || 0) + 1
  });

  res.json({ success: true, path: filePath });
});

// Delete a file — owner maintenance operation
router.delete('/:id/files/*', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.params[0];
  await deleteFile(req.params.id, filePath);

  const existing = await query('files', f => String(f.project_id) === String(req.params.id) && f.path === filePath);
  for (const f of existing) await remove('files', f.id);

  // Stored-content change = a new prototype version, same convention as
  // uploads and edits (keeps the "平台存储 v{n}" badge consistent).
  await update('projects', req.params.id, {
    version: (project.version || 0) + 1
  });

  res.json({ success: true });
});

/**
 * Inject a client script into prototype HTML that:
 *  1. Reports iframe scroll position to the parent window via postMessage,
 *     so annotation anchors can follow the page as it scrolls.
 *  2. Intercepts <a> clicks: relative / same-origin links navigate INSIDE the
 *     iframe (overriding target="_blank" and <base target>), so prototype
 *     sub-pages stay within the review frame. External absolute links keep
 *     opening in a new tab.
 *  3. Reports the current page path to the parent ({__protoNav:1, path}),
 *     so the review UI can filter annotations per page.
 * Idempotent: skips if already injected (marker in the HTML).
 */
function injectScrollSyncScript(html) {
  if (!html) return html;

  // 旧版本注入过的原型（例如以往会话把已注入的页面原样保存）可能已带有一段
  // 早期 proto-scroll-sync 脚本及其 __protoScrollInjected 标记。若不清理，
  // 会触发下面的幂等短路，导致新增的悬停高亮/目标定位处理器永远无法上线。
  // 因此先剥离旧的注入脚本（及其标记），再统一注入最新版本，保证注入恰好一次。
  html = html.replace(/<script\b[^>]*>[\s\S]*?\/\*proto-scroll-sync\*\/[\s\S]*?<\/script>/gi, '');
  html = html.split('__protoScrollInjected').join('');

  // data-hve-editor 标记让编辑器的序列化器（html-serializer.js）在保存时把这段
  // 运行时注入脚本一并剥离，避免把它（含 __protoScrollInjected 标记、window.open
  // 覆写、点击拦截）持久化进原型文件。服务端每次 serve 都会重新注入，不受影响。
  const script = '<script data-hve-editor="true">/*proto-scroll-sync*/!function(){if(window.__protoScrollInjected)return;window.__protoScrollInjected=1;' +
    // 1. scroll sync (also report document size so the overlay can map
    //    document-relative anchor percentages to the current viewport)
    'function s(){try{window.parent.postMessage({__protoScroll:1,x:window.scrollX||0,y:window.scrollY||0,docWidth:Math.max(document.documentElement.scrollWidth||1,document.body.scrollWidth||1),docHeight:Math.max(document.documentElement.scrollHeight||1,document.body.scrollHeight||1)},"*")}catch(e){}}' +
    'window.addEventListener("scroll",s,{capture:true,passive:true});window.addEventListener("resize",s,{passive:true});' +
    // 2. page navigation reporting
    'function nav(){try{window.parent.postMessage({__protoNav:1,path:location.pathname+location.search},"*")}catch(e){}}' +
    'window.addEventListener("load",function(){nav();s()});' +
    // 3. link interception
    'function findA(t){for(var n=t;n&&n!==document;n=n.parentNode){if(n.tagName==="A")return n}return null}' +
    'document.addEventListener("click",function(e){' +
    'var a=findA(e.target);if(!a)return;' +
    'var href=a.getAttribute("href");if(!href)return;' +
    'if(href.charAt(0)==="#")return;' +
    'if(/^(javascript:|mailto:|tel:)/i.test(href))return;' +
    'var abs;try{abs=new URL(href,location.href)}catch(_){return}' +
    // external link: force a new tab (default target may be _self)
    'if(abs.origin!==location.origin){a.setAttribute("target","_blank");return}' +
    // same-page hash jump: let the browser handle it
    'if(abs.href.split("#")[0]===location.href.split("#")[0]&&abs.hash)return;' +
    'e.preventDefault();' +
    'if(abs.href!==location.href)location.href=abs.href' +
    '},true);' +
    // 4. override window.open so JS-driven same-origin popups stay inside the iframe
    'var _wopen=window.open;window.open=function(url,target,features){' +
    'if(url){try{var u=new URL(url,location.href);if(u.origin===location.origin){var t=(target||"").toLowerCase();if(t==="_blank"||t===""){location.href=u.href;return window;}}}catch(_){}}' +
    'return _wopen.apply(this,arguments)};' +
    // 5. probe the DOM element under a viewport point (used by the annotation overlay)
    //    and answer position queries for already-anchored annotations.
    'function buildPath(el){var path=[];var p=el;while(p&&p!==document.body){var seg=p.tagName?p.tagName.toLowerCase():"";if(p.id&&p.id.trim)seg+="#"+p.id.trim();else{var c=(p.className&&typeof p.className==="string")?p.className.trim().split(/\\s+/).filter(function(x){return x}).slice(0,2):[];var nth=0;var sib=p;while(sib){if(sib.tagName===p.tagName)nth++;sib=sib.previousElementSibling;}if(c.length&&c[0])seg+="."+c.join(".");if(nth>1)seg+=":nth-of-type("+nth+")";}path.unshift(seg);p=p.parentNode;}return path.join(" > ");}' +
    'function buildElementInfo(el,dx,dy){' +
    'var info={found:true,tagName:el.tagName,elementId:el.id||"",className:el.className||""};' +
    'info.text=(el.innerText||el.textContent||"").slice(0,300);' +
    'info.isHeading=/^H[1-6]$/i.test(el.tagName);' +
    'try{info.fontSize=window.getComputedStyle(el).fontSize}catch(_){}' +
    'var r=el.getBoundingClientRect();' +
    'var sx=window.scrollX||0,sy=window.scrollY||0;' +
    'var docW=Math.max(document.documentElement.scrollWidth||1,document.body.scrollWidth||1);' +
    'var docH=Math.max(document.documentElement.scrollHeight||1,document.body.scrollHeight||1);' +
    'info.rect={left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom};' +
    'info.scrollX=sx;info.scrollY=sy;' +
    'info.docRect={left:r.left+sx,top:r.top+sy,width:r.width,height:r.height};' +
    'info.docSize={width:docW,height:docH};' +
    // 质量提示：过小元素锚点不稳定；HTML/BODY 等通用容器属于页面级定位，不精确。
    'info.undersized=(r.width<2||r.height<2);' +
    'info.generic=/^(HTML|BODY|MAIN|SECTION|ARTICLE)$/i.test(el.tagName);' +
    'if(typeof dx==="number"&&typeof dy==="number"){' +
    'info.offsetX=r.width>0?((dx-r.left)/r.width):0.5;' +
    'info.offsetY=r.height>0?((dy-r.top)/r.height):0;' +
    'info.docX=(dx+sx)/docW;' +
    'info.docY=(dy+sy)/docH;' +
    '}' +
    'info.path=buildPath(el);' +
    'info.modalId=findModalOwner(el);' +
    'var parent=el.parentNode;' +
    'if(parent){info.parentTag=parent.tagName||"";info.parentText=(parent.innerText||parent.textContent||"").slice(0,300);}' +
    'return info;}' +
    // Nearest dialog/modal ancestor id, so annotations on elements inside a
    // popup are scoped to that modal and never re-anchor to a same-shaped
    // element at a different level (or hidden twin) on the page.
    'function findModalOwner(el){var p=el.parentNode;while(p&&p!==document.documentElement){' +
    'var dlg=p.tagName==="DIALOG";' +
    'try{var ro=p.getAttribute&&p.getAttribute("role");if(ro==="dialog"||ro==="alertdialog")dlg=true;}catch(_){}' +
    'var cn=(p.className&&typeof p.className==="string")?""+p.className:"";' +
    'if(!dlg&&/modal|popup|dialog|drawer|layer|toast|pop/i.test(cn))dlg=true;' +
    'if(dlg&&p.id&&p.id.trim()){return p.id.trim();}' +
    'p=p.parentNode;}return "";}' +
    // Extract an element id from a stored scope ("modal:x" / "drawer:x" /
    // "dialog:x") so scoped annotations resolve inside that overlay even when
    // the annotation was created before element-level modalId tracking existed.
    'function scopeFindId(sco){var sx=String(sco||"");return sx.indexOf("modal:")===0?sx.slice(6):(sx.indexOf("drawer:")===0?sx.slice(7):(sx.indexOf("dialog:")===0?sx.slice(7):""));}' +
    // --- 弹层作用域广播（对应 prototype-annotation 的“最高作用域”机制）---
    // 观察 DOM 里可见的弹窗/抽屉（按 z-index 取最高者），把当前顶层作用域推给
    // 父页面：弹窗开着时只显示 modal:{id} 批注，关闭后恢复页面级批注。
    'function isElVisible(n){try{var st=getComputedStyle(n);if(n.getAttribute&&n.getAttribute("aria-hidden")==="true")return false;if(st.display==="none"||st.visibility==="hidden")return false;var rr=n.getBoundingClientRect();return rr.width>0&&rr.height>0;}catch(e){return false;}}' +
    // 元素所在子树整体可见（沿祖先链检查 display/visibility/hidden），用于锚点
    // 查询：目标元素处于关闭的弹窗/抽屉或隐藏区域时，视为“未找到”，父页面略过。
    'function isDeepVisible(n){var nd=n;while(nd&&nd.nodeType===1&&nd!==document.body){var sv;try{sv=window.getComputedStyle(nd)}catch(eS){break}if(nd.hidden||(nd.getAttribute&&nd.getAttribute("aria-hidden")==="true"))return false;if(sv.display==="none"||sv.visibility==="hidden")return false;if(Number(sv.opacity)===0)return false;nd=nd.parentNode;}return true;}' +
    'function computeOverlayScope(){var cands=document.querySelectorAll("[id][data-modal],[id][data-drawer],[id][data-dialog],[role=dialog][id],[role=alertdialog][id],.modal-overlay[id],.drawer-overlay[id]");var top=null;for(var i=0;i<cands.length;i++){var n=cands[i];if(!isElVisible(n))continue;var z=0;try{z=parseInt(getComputedStyle(n).zIndex,10)||0}catch(e){}var cn="";try{cn=n.className&&typeof n.className==="string"?n.className:""}catch(e2){}var kind=/drawer|side|draw/i.test(cn)?"drawer":"modal";if(!top||z>top.z)top={id:n.id,kind:kind,z:z};}return top?top.kind+":"+top.id:null;}' +
    'var _ocv=null,_ocq=0;function emitOverlayScope(){var s=computeOverlayScope();if(s===_ocv)return;_ocv=s;try{window.parent.postMessage({__protoScopeState:1,scope:s},"*")}catch(e){}}' +
    'function overlayDebounced(){if(_ocq)clearTimeout(_ocq);_ocq=setTimeout(function(){_ocq=0;emitOverlayScope()},350);}' +
    'window.addEventListener("message",function(e){' +
    'var d=e.data;if(!d)return;' +
    'if(d.__protoScopeNow===1){var sn=null;try{sn=computeOverlayScope()}catch(e3){}window.parent.postMessage({__protoScopeState:1,scope:sn},"*");return;}' +
    'if(d.__protoProbe===1){' +
    'var info={__protoElement:1,id:d.id,found:false};' +
    'try{' +
    'var el=document.elementFromPoint(d.x,d.y);' +
    'if(!el)return window.parent.postMessage(info,"*");' +
    'Object.assign(info,buildElementInfo(el,d.x,d.y));' +
    // 作用域：命中元素若在弹窗/抽屉内，则记录为 modal/drawer 作用域，否则为页面级。
    // 供前端在创建批注、查询锚点、展示 pin 及写回 DB（annotations.scope）时使用。
    'info.scope=(info.modalId?(/^(ASIDE|NAV|MENU)$/i.test(info.parentTag||"")?"drawer:":"modal:"):"page:")+(info.modalId||(d.page&&d.page.trim()?d.page:"index.html"));' +
    'info.page=d.page||info.page||"index.html";' +
    '}catch(err){info.error=err.message;}' +
    'window.parent.postMessage(info,"*");' +
    'return;}' +
    'if(d.__protoQuery===1){' +
    'var res={__protoElementPos:1,id:d.id,found:false};' +
    'try{' +
    'var el=null;' +
    'if(!d.modalId&&d.scope)d.modalId=scopeFindId(d.scope);' +
    'if(d.elementId)el=document.getElementById(d.elementId);' +
    // Prefer resolving inside the recorded modal (scoped lookup) before any
    // global path/text search, so same-shaped elements at different levels do
    // not collide. Falls back to the legacy global search for old annotations.
    'if(!el&&d.modalId){var mm0=document.getElementById(d.modalId);if(mm0){' +
    'if(d.path){try{el=mm0.querySelector(d.path);}catch(_){}}' +
    'if(!el&&d.text){var mw=document.createTreeWalker(mm0,NodeFilter.SHOW_TEXT,null,false);var mn;while(mn=mw.nextNode()){if(mn.textContent.indexOf(d.text)!==-1){el=mn.parentElement;break;}}}}}' +
    'if(!el&&d.path){try{el=document.querySelector(d.path);}catch(_){}}' +
    'if(!el&&d.text){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);var node;while(node=walker.nextNode()){if(node.textContent.indexOf(d.text)!==-1){el=node.parentElement;break;}}}' +
    // 目标在关闭的弹窗/隐藏子树里时不算“找到”，父页面据此隐藏该锚点。
    'if(el&&!isDeepVisible(el))el=null;' +
    'if(el){Object.assign(res,buildElementInfo(el,0,0));res.viewport={width:window.innerWidth,height:window.innerHeight};}' +
    '}catch(err){res.error=err.message;}' +
    'window.parent.postMessage(res,"*");' +
    'return;}' +
    // 6. annotation targeting (参考 html-annotation-editor 的“选择目标区域”):
    //    悬停时在原型内用虚线框标出当前命中的元素，让批注作者看清锚点会落在
    //    哪个区域；点击后的 __protoProbe 探针命中的是同一元素。激活某条批注时
    //    用 __protoReveal 滚动并闪烁高亮其目标元素。
    'var _hl=null;function makeHl(){if(_hl)return _hl;' +
    'var e=document.createElement("div");e.setAttribute("data-hve-editor","true");e.style.cssText="position:absolute;z-index:2147483645;pointer-events:none;box-sizing:border-box;border-radius:3px;";document.documentElement.appendChild(e);_hl=e;return e;}' +
    'function showHl(r,opts){var e=makeHl();var o=opts||{};e.style.left=(r.left+(window.scrollX||0))+"px";e.style.top=(r.top+(window.scrollY||0))+"px";e.style.width=r.width+"px";e.style.height=r.height+"px";e.style.border=o.border||"2px dashed #f97316";e.style.background=o.background||"rgba(249,115,22,0.12)";e.style.display="block";return e;}' +
    'function hideHl(){if(_hl){_hl.style.display="none";}}' +
    'if(d.__protoHighlight===1){var he=null;try{he=document.elementFromPoint(d.x,d.y);}catch(e){}try{' +
    'if(he&&he.tagName!=="HTML"){var hr=he.getBoundingClientRect();showHl(hr,{});var hi=buildElementInfo(he,d.x,d.y);window.parent.postMessage({__protoHoverInfo:1,found:true,tag:hi.tagName,id:hi.elementId,text:hi.text},"*");}else{hideHl();window.parent.postMessage({__protoHoverInfo:1,found:false},"*");}}catch(e2){hideHl();window.parent.postMessage({__protoHoverInfo:1,found:false},"*");}return;}' +
    'if(d.__protoHoverClear===1){hideHl();return;}' +
    'if(d.__protoReveal===1){var rel=null;try{' +
    'if(!d.modalId&&d.scope)d.modalId=scopeFindId(d.scope);' +
    'if(d.elementId)rel=document.getElementById(d.elementId);' +
    'if(!rel&&d.modalId){var mm1=document.getElementById(d.modalId);if(mm1){' +
    'if(d.path){try{rel=mm1.querySelector(d.path);}catch(_e){}}' +
    'if(!rel&&d.text){var tw1=document.createTreeWalker(mm1,NodeFilter.SHOW_TEXT,null,false);var n1;while(n1=tw1.nextNode()){if(n1.textContent.indexOf(d.text)!==-1){rel=n1.parentElement;break;}}}}}' +
    'if(!rel&&d.path){try{rel=document.querySelector(d.path);}catch(_e){}}' +
    'if(!rel&&d.text){var wk1=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);var n2;while(n2=wk1.nextNode()){if(n2.textContent.indexOf(d.text)!==-1){rel=n2.parentElement;break;}}}' +
    '}catch(er){}' +
    'if(rel&&(function(){try{return isDeepVisible(rel)}catch(_e){return true}})()){try{rel.scrollIntoView({block:"center",behavior:"smooth"});}catch(e3){try{rel.scrollIntoView(true);}catch(_e){}}' +
    'setTimeout(function(){var rr0=rel.getBoundingClientRect();showHl(rr0,{border:"2px solid #dc2626",background:"rgba(220,38,38,0.10)"});setTimeout(hideHl,1600);},120);' +
    'window.parent.postMessage({__protoRevealed:1,id:d.id,found:true},"*");}' +
    'else{window.parent.postMessage({__protoRevealed:1,id:d.id,found:false},"*");}' +
    'return;}' +
    '});' +
    // 初始化：注册弹层变化观察者，文档加载后推一次当前作用域。
    'var _mo=new MutationObserver(function(){overlayDebounced()});' +
    'try{_mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style","hidden","aria-hidden"]});}catch(e4){}' +
    'setTimeout(emitOverlayScope,10);' +
    'nav();document.readyState!=="loading"&&s()}();</script>';

  if (html.toLowerCase().indexOf('</body>') !== -1) {
    return html.replace(/<\/body>/i, script + '</body>');
  }
  return html + script;
}

/**
 * Inject the ProtoBuddy visual-editor bootstrap into prototype HTML.
 *
 * This is a LAZY loader, not the editor itself: it adds ~1.5KB of inline JS
 * that waits for the parent review page to send {__pbEdit:{v:1}} (edit mode
 * on / off). Only then does it load the editor stylesheet + modules (served
 * at /api/editor/*) and call HVE_Core.enable().
 *
 * Save flow: the editor serializes the live DOM back to HTML and posts
 * {__pbSave:{page,html}} to the parent window (ProtoBuddy review app), which
 * writes the file back to the project through the owner-gated files API and
 * replies {__pbSaveRes:{ok,error}}.
 *
 * Clean-up: the bootstrap <script> carries data-hve-editor so that the
 * editor's HTML serializer (html-serializer.js) strips it from saved output,
 * exactly as it strips the editor's own injected UI. The persisted file thus
 * contains no editor code; the server re-injects the bootstrap on every load.
 * Idempotent: skips if already present (marker string + a __proto flag).
 */
function injectEditorBootstrap(html) {
  if (!html || html.indexOf('__pbEditorBootstrap') !== -1) return html;

  // The whole injected editor bootstrap. It is a small LAZY loader, not the
  // editor itself:
  //  - pre-warms by loading the editor modules on document load (parallel),
  //  - waits for the parent review page to send {__pbEdit:{v:1}} and then
  //    enables via HVE_Core.enable() (or disables on v:0),
  //  - asks the editor to save when it receives {__pbAskSave:1}.
  // data-hve-editor lets the HTML serializer strip all of it from saved output.
  const script = '<script data-hve-editor="true" data-proto-editor="true">' +
`/*__pbEditorBootstrap*/
(function(){
  if (window.__pbEditorInit) return;
  window.__pbEditorInit = 1;
  var editorBases = ["/editor/", "/api/editor/"], BASE = null;
  var MODULES = ["html-serializer.js","proto-file-manager.js","history.js","selector.js","drag-move.js","resize.js","text-edit.js","table-edit.js","image-handler.js","align-guide.js","zoom.js","toolbar.js","insert-panel.js","context-menu.js","dom-freeze.js","editor-core.js"];
  // Bump whenever /editor/* assets change so deployed pages retire the browser
  // cache instead of running a stale (e.g. pre click-guard) module build.
  var ASSET_VER = "2026-09-zoom3";
  var active = false, loading = false;
  function report(){ try { window.parent.postMessage({ __pbEditReady:1, active:active }, "*"); } catch(e){} }
  function resolveBase(cb){
    if (BASE) return cb(BASE);
    var i = 0;
    (function probe(){
      if (i >= editorBases.length) return cb(null);
      var b = editorBases[i++];
      var x = new XMLHttpRequest();
      try { x.open("GET", b + "editor.css", true); } catch(e){ return probe(); }
      x.onloadend = function(){ if (x.status >= 200 && x.status < 300) { BASE = b; cb(b); } else probe(); };
      x.onerror = probe;
      x.send();
    })();
  }
  function loadModules(){
    if (loading) return Promise.resolve(true);
    loading = true;
    // Parallel module download; classic <script> tags still execute in injection
    // order, so editor-core.js (appended last) initializes last.
    return new Promise(function(res){
      resolveBase(function(ok){
        if (!ok) { loading = false; return res(false); }
        var css = document.createElement("link");
        css.rel = "stylesheet"; css.href = BASE + "editor.css?v=" + ASSET_VER;
        css.setAttribute("data-hve-editor", "true");
        (document.head || document.documentElement).appendChild(css);
        var total = MODULES.length, done = 0, target = document.body || document.documentElement;
        for (var i = 0; i < total; i++) {
          (function(name){
            var s = document.createElement("script");
            s.src = BASE + "modules/" + name + "?v=" + ASSET_VER;
            s.setAttribute("data-hve-editor", "true");
            s.onload = s.onerror = function(){ done++; if (done >= total) { loading = false; res(true); } };
            target.appendChild(s);
          })(MODULES[i]);
        }
      });
    });
  }
  function enable(){
    if (active) return report();
    if (window.HVE_Core) { window.HVE_Core.enable(); active = true; return report(); }
    loadModules().then(function(ok){
      // Once the user asked for edit mode we MUST end up active: the ack drives
      // the parent's toggle. Keep polling until the core actually landed (fast
      // with parallel load + cache) instead of reporting an impatient "false".
      (function tryEnable(){
        if (ok && window.HVE_Core) { window.HVE_Core.enable(); active = true; }
        if (active) return report();
        setTimeout(tryEnable, 150);
      })();
    });
  }
  function disable(){ if (active && window.HVE_Core) window.HVE_Core.disable(); active = false; report(); }
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d) return;
    if (typeof d.__pbEdit !== "undefined") { d.__pbEdit.v === 1 ? enable() : disable(); return; }
    if (d.__pbAskSave === 1 && active && window.HVE_Core) window.HVE_Core.saveCurrentFile();
  });
  // Pre-warm: load the editor modules in the background right away, so the
  // very first 可视化编辑 press toggles in roughly a page-load, not 10-15s.
  loadModules();
})();</script>`;

  if (html.toLowerCase().indexOf('</body>') !== -1) {
    return html.replace(/<\/body>/i, script + '</body>');
  }
  return html + script;
}

// Send content with proper content-type; HTML gets scroll-sync injection
function sendContent(res, filePath, content) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  if (isBinaryFile(filePath)) {
    const buf = Buffer.from(content.data, 'base64');
    res.type(ext).send(buf);
    return;
  }

  let text = content.data;
  if (ext === 'html' || ext === 'htm') {
    text = injectScrollSyncScript(text);
    text = injectEditorBootstrap(text);
    res.type('html').send(text);
  } else {
    res.type(ext || 'text/plain').send(text);
  }
}

// Serve static prototype files (local hosting fallback + iframe source).
// Shared by both /:id/preview/* and /:id/preview (no trailing slash) — the
// old "set params[0] then next()" trick falls through because the wildcard
// route requires a slash after /preview, dropping the request into the
// app-level 404 catch-all.
async function servePreview(req, res, next) {
  try {
    const project = await getById('projects', req.params.id);
    if (!project) return res.status(404).send('Project not found');

    // Get the requested file path (after /preview/)
    let reqPath = req.params[0] || '';
    if (!reqPath || reqPath === '' || reqPath === '/') {
      // Use the storage driver's entry point discovery: root index.html first,
      // otherwise the index.html inside the shallowest subdirectory (ZIPs often
      // wrap everything in a top-level folder, e.g. "原型设计/").
      const entry = await findEntryPoint(req.params.id);
      reqPath = entry ? `${entry}/index.html` : 'index.html';
    } else if (reqPath.endsWith('/')) {
      // Directory-style request (/preview/phase-2/) -> its index.html
      reqPath += 'index.html';
    }

  // Guard against traversal (the storage drivers normalize paths, but be explicit)
  if (reqPath.split('/').some(seg => seg === '..')) {
    return res.status(403).send('Forbidden');
  }

  // Try the requested path, then as a directory (index.html inside)
  let content = await readFileContent(req.params.id, reqPath);
  if (!content) {
    content = await readFileContent(req.params.id, `${reqPath}/index.html`);
  }
  // ZIP-wrapped projects: the entry index.html lives in a subdirectory (e.g.
  // "原型设计/") but the iframe root URL is /preview/, so relative sub-page
  // links resolve against the root (e.g. /preview/04-商家控制台.html). Retry
  // with the entry directory prefix so those links serve correctly.
  // The entry directory IS the prototype root, so the prefix is `${entry}/`
  // (the old code took entry's PARENT dir, which only worked when the entry
  // happened to be nested and broke single-level entries like `phase-2/`).
  if (!content) {
    const entry = await findEntryPoint(req.params.id);
    const entryRoot = entry ? `${entry}/` : '';
    if (entryRoot && !reqPath.startsWith(entryRoot)) {
      content = await readFileContent(req.params.id, entryRoot + reqPath);
      if (!content) {
        content = await readFileContent(req.params.id, `${entryRoot}${reqPath}/index.html`);
      }
    }
  }
  if (!content) {
    return res.status(404).send('File not found');
  }

  sendContent(res, reqPath, content);
  } catch (err) {
    next(err);
  }
}

router.get('/:id/preview/*', servePreview);

// Preview root (no file specified, no trailing slash)
router.get('/:id/preview', servePreview);

export default router;

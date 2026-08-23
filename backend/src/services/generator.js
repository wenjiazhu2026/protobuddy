/**
 * Python 生成器检测与执行（方案 A：外部执行环境）。
 *
 * 背景：原型项目可以约定「HTML 由 Python 脚本生成」——例如 CIS 阶段二原型的
 * phase-2/AGENTS.md 规定所有改动必须写入 _gen_pages.py 并重新生成。此时如果
 * 方案应用只改了生成器脚本而不重新执行，部署出去的就是旧 HTML（线上实测发现
 * 的缺口：plan 245 apply 后部署正常执行，但页面无变化）。
 *
 * 本模块在「部署/应用」链路前插入一个环节：检测生成器脚本 → 重新执行 →
 * 确保部署的是最新产物。执行环境的差异决定了处理方式：
 *
 * - local 模式（本地后端 / STORAGE_DRIVER=local）：项目文件在本机 FS，可直接
 *   exec python3，自动完成「改脚本 → 重新生成 → 部署新产物」的完整闭环。
 * - blob 模式（EdgeOne Makers Cloud Functions）：函数文件系统只读、无法 exec
 *   Python（120s 限制之外的根本约束），返回 needsExternal:true，由
 *   scripts/regenerate.js CLI 在本机充当外部执行环境
 *   （拉取 blob → 本地执行 → 回写产物 → 触发重新部署）。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listProjectFiles, getProjectDir, readFileContent } from './fileStorage.js';
import { isBlobMode } from '../config.js';

// execFile（不经 shell）+ 参数数组：脚本路径作为单个 argv 传入，任何特殊字符
// 都不可能被解释为 shell 元字符（此前的 exec 模板字符串拼接存在命令注入风险）。
const execFileAsync = promisify(execFile);

/** 生成器脚本识别规则（相对路径 basename 匹配）。 */
const GENERATOR_PATTERNS = [
  /^_?gen[a-z0-9_]*\.py$/i,      // _gen_pages.py / gen_pages.py / gen_data.py
  /^generate[a-z0-9_]*\.py$/i,   // generate_pages.py
  /^build\.py$/i,                // build.py
  /^make[a-z0-9_]*\.py$/i        // make_site.py
];

const GENERATOR_TIMEOUT_MS = 120000; // 2min（生成器脚本一般秒级，大站点预留余量）
const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024; // 超过 5MB 的文件只记 size+mtime，不读内容

// 生成器执行期间不应参与产物对比的目录
const SKIP_DIRS = new Set(['node_modules', '.git', '.edgeone', 'dist']);

function isGeneratorFile(relPath) {
  const base = relPath.split('/').pop() || '';
  return GENERATOR_PATTERNS.some(p => p.test(base));
}

/**
 * 扫描项目，识别生成器脚本。
 * 优先 entry 目录内、其次根目录；同优先级取路径较短的（更靠近入口）。
 * @returns {Promise<{script:string, entryDir:string}|null>} script 为相对项目根的路径
 */
export async function detectGenerator(projectId) {
  const files = await listProjectFiles(projectId);
  const entry = await findEntryPointRel(projectId, files);

  const candidates = files
    .filter(f => isGeneratorFile(f))
    .map(f => ({
      script: f,
      entryDir: entry,
      // entry 目录内的生成器优先（原型入口即生成器工作目录）；同为 entry 内时短路径优先
      rank: (entry && f.startsWith(entry + '/')) ? 0 : 1,
      depth: f.split('/').length
    }))
    .sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.script.localeCompare(b.script));

  if (candidates.length === 0) return null;
  const top = candidates[0];
  return { script: top.script, entryDir: top.entryDir };
}

/** 复用存储驱动的入口发现逻辑（避免循环依赖：fileStorage.js 依赖 config，无环）。 */
async function findEntryPointRel(projectId, files) {
  // 根 index.html 存在 → 入口为根
  if (files.includes('index.html')) return '';
  // 找最深层的 index.html 所在目录
  const indexes = files.filter(f => f.endsWith('/index.html') || f === 'index.html');
  if (indexes.length === 0) return '';
  let best = '';
  for (const f of indexes) {
    const dir = f.replace(/\/index\.html$/, '');
    if (dir.split('/').length > best.split('/').length) best = dir;
  }
  return best;
}

/* ------------------------------- 产物快照与 diff ------------------------------- */

function walkDir(dir, relBase = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(path.join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name, out);
    } else {
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      out.push(relBase ? `${relBase}/${entry.name}` : entry.name);
    }
  }
  return out;
}

function fileFingerprint(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    if (st.size > SNAPSHOT_MAX_BYTES) {
      return `big:${st.size}:${st.mtimeMs}`;
    }
    const buf = fs.readFileSync(fullPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/** 对项目目录做内容快照（path -> fingerprint），用于执行前后的产物 diff。 */
export function snapshotProject(projectDir) {
  const map = {};
  for (const rel of walkDir(projectDir)) {
    const fp = fileFingerprint(path.join(projectDir, rel));
    if (fp !== null) map[rel] = fp;
  }
  return map;
}

/**
 * 对比执行前后快照。
 * @returns {Array<{path:string, action:'added'|'modified'|'removed'}>}
 */
export function diffSnapshots(before, after) {
  const changes = [];
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) changes.push({ path: rel, action: 'added' });
    else if (before[rel] !== after[rel]) changes.push({ path: rel, action: 'modified' });
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) changes.push({ path: rel, action: 'removed' });
  }
  // 稳定排序：产物（html/css/js）优先展示
  return changes.sort((a, b) => {
    const score = p => (p.endsWith('.html') || p.endsWith('.htm') ? 0 : p.endsWith('.css') || p.endsWith('.js') ? 1 : 2);
    return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
  });
}

/** 探测可用的 python3 可执行文件（外部执行环境 = 本机，候选顺序：显式配置 > PATH > 系统）。 */
function resolvePython() {
  if (process.env.GENERATOR_PYTHON) return process.env.GENERATOR_PYTHON;
  return 'python3';
}

/**
 * 本地执行生成器脚本并 diff 产物（仅 local 模式可用）。
 * @param {number|string} projectId
 * @param {string} script 相对项目根的脚本路径（如 'phase-2/_gen_pages.py'）
 * @returns {Promise<{ok:boolean, stdout?:string, stderr?:string, exitCode?:number, changedFiles?:Array, error?:string}>}
 */
export async function runGeneratorLocal(projectId, script) {
  const projectDir = await getProjectDir(projectId);
  const scriptPath = path.resolve(projectDir, String(script || ''));
  // 路径边界守卫：脚本必须位于项目目录内（防 ../ 逃逸执行任意文件）。
  if (!scriptPath.startsWith(projectDir + path.sep)) {
    return { ok: false, error: `生成器脚本路径越界: ${script}` };
  }
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `生成器脚本不存在: ${script}` };
  }
  // cwd = 脚本所在目录，保证脚本内相对路径（open('index.html') 等）以脚本位置为基准
  const scriptDir = path.dirname(scriptPath);

  const before = snapshotProject(projectDir);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const res = await execFileAsync(resolvePython(), [scriptPath], {
      cwd: scriptDir,
      timeout: GENERATOR_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    stdout = res.stdout || '';
    stderr = res.stderr || '';
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = typeof err.code === 'number' ? err.code : 1;
    return {
      ok: false,
      exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
      error: `生成器执行失败（exit ${exitCode}）: ${(stderr || stdout || err.message).trim().slice(0, 500)}`
    };
  }

  const after = snapshotProject(projectDir);
  const changedFiles = diffSnapshots(before, after);

  return { ok: true, exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), changedFiles };
}

/**
 * 部署/应用前的统一入口：检测生成器并准备最新产物。
 *
 * @param {number|string} projectId
 * @param {{force?:boolean}} [opts] force=true 时跳过生成器检查（确认产物已最新，如纯上传新 HTML）
 * @returns {Promise<object>}
 *   - 无生成器: {generator:null}
 *   - blob 且未 force: {generator, needsExternal:true, message}
 *   - blob 且 force:  {generator, forced:true}
 *   - local:          {generator, ran:true, ok, stdout, stderr, changedFiles} 或 {generator, ran:true, ok:false, error}
 */
export async function prepareForDeploy(projectId, { force = false, changes = [] } = {}) {
  const generator = await detectGenerator(projectId);
  if (!generator) return { generator: null };
  if (force) return { generator, forced: true };

  if (isBlobMode()) {
    // Generator handling on the read-only Cloud Function runtime:
    //   1. apply didn't touch any generator script (.py) → no regeneration
    //      needed, deploy whatever is in storage (HTML may have been edited
    //      directly, or the change was to CSS/JS/etc).
    //   2. apply touched the generator .py AND at least one HTML output →
    //      dual-write: the model already produced the paired HTML artifact,
    //      so the deployed HTML is the newest version — deploy directly,
    //      skip external Python regeneration.
    //   3. apply touched only the generator .py (no HTML) → must regenerate
    //      externally; return needsExternal so scripts/regenerate.js does it.
    const touched = new Set((changes || []).map(c => c.file_path).filter(Boolean));
    const pyTouched = [...touched].some(p => isGeneratorFile(p));
    if (!pyTouched) {
      return { generator, skipped: true, message: `本次未修改生成器脚本 ${generator.script}，直接部署现有产物。` };
    }
    const htmlTouched = [...touched].some(p => /\.html?$/i.test(p));
    if (htmlTouched) {
      const syncedHtmlFiles = [...touched].filter(p => /\.html?$/i.test(p));
      return {
        generator,
        synced: true,
        syncedHtmlFiles,
        message: `检测到生成器脚本 ${generator.script} 与 HTML 产物已同步修改（${syncedHtmlFiles.length} 个 HTML），直接部署最新产物。`
      };
    }
    return {
      generator,
      needsExternal: true,
      message: `项目包含 Python 生成器脚本 ${generator.script}，但线上函数环境（只读文件系统）无法执行 Python。` +
        `请使用外部执行环境重新生成 HTML 后再部署：node scripts/regenerate.js --project ${projectId}` +
        `（或确认产物已是最新后用 force 强制部署）。`
    };
  }

  return { generator, ran: true, ...(await runGeneratorLocal(projectId, generator.script)) };
}

/** 供外部 CLI 复用的：纯路径判断（不依赖存储驱动）。 */
export { isGeneratorFile };

/** 生成器执行环境能力探测（写入部署日志，便于排障）。 */
export async function probeGeneratorEnv() {
  if (isBlobMode()) {
    return { mode: 'blob', canExecPython: false, reason: 'Cloud Function read-only filesystem' };
  }
  try {
    const { stdout } = await execFileAsync(resolvePython(), ['--version'], { timeout: 10000 });
    return { mode: 'local', canExecPython: true, python: (stdout || '').trim() };
  } catch (err) {
    return { mode: 'local', canExecPython: false, error: err.message };
  }
}

/** 供 CLI / 调试读取生成器脚本内容（限制大小，避免大文件打爆响应）。 */
export async function readGeneratorScript(projectId, script, maxChars = 20000) {
  const content = await readFileContent(projectId, script);
  if (!content || content.binary) return null;
  return content.data.slice(0, maxChars);
}

/**
 * 从请求推导对外可访问的 API 基址（供 regenerate hint 使用）。
 * EdgeOne Pages 平台实测（_debug/headers）：`host` 被重写为内部 SCF host
 * （pages-scf-*.qcloudteo.com），公共 host 放在 `eo-pages-host` 头；
 * 无 x-forwarded-proto/x-forwarded-host。取头顺序：
 *   host: eo-pages-host > x-forwarded-host > req host > localhost
 *   proto: 有 eo-pages-host 时必为 https，否则 x-forwarded-proto > req.protocol > http
 * 本地 dev 无转发头时回退 req 自身值。
 */
export function apiBaseFromReq(req) {
  const eoHost = req.headers['eo-pages-host'];
  const proto = eoHost ? 'https' : (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = eoHost || req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3001';
  let base = `${proto}://${host}`;
  // 请求本身带 eo_token（部署链接访问）时回显到 hint，外部 CLI 需要它做平台授权握手
  if (req.query && req.query.eo_token) {
    const q = new URLSearchParams();
    q.set('eo_token', req.query.eo_token);
    if (req.query.eo_time) q.set('eo_time', req.query.eo_time);
    base += `?${q.toString()}`;
  }
  return base;
}

#!/usr/bin/env node
/**
 * ProtoBuddy 生成器「外部执行环境」CLI（方案 A）。
 *
 * 背景：项目部署在 EdgeOne Makers（blob 存储 + Cloud Functions）时，函数文件
 * 系统只读、无法执行 Python。若原型含 Python 生成器脚本（如 phase-2/_gen_pages.py，
 * 按 AGENTS.md 约定所有改动写入脚本并重新生成 HTML），线上只能存储脚本、无法
 * 重新生成产物 —— 直接部署出去的就是旧 HTML。
 *
 * 本 CLI 在本机充当外部执行环境，打通完整闭环：
 *
 *   1. owner 密码验证（或复用已签发的 token）→ X-Owner-Token
 *   2. 从线上 API 拉取项目全部文件 → 还原到本地临时目录
 *   3. 本地执行 python3 <生成器脚本> → 重新生成 HTML 等产物
 *   4. diff 产物变化（执行前后内容快照对比）
 *   5. 将变化文件回写线上存储（POST/DELETE /api/projects/:id/files）
 *   6. 触发线上重新部署（POST /api/projects/:id/deploy）
 *
 * 用法：
 *   node scripts/regenerate.js --project 1 --api https://protobuddy-app.edgeone.cool --password <owner密码>
 *   node scripts/regenerate.js --project 1 --api <base> --token <ownerToken>          # 复用已有 token
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --skip-deploy # 只生成+回写，不部署
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --force       # 跳过生成器检查强制部署
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --keep        # 保留本地工作目录
 *
 * 环境变量替代参数：PB_API / PB_PROJECT / PB_OWNER_PASSWORD / PB_OWNER_TOKEN
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isGeneratorFile, snapshotProject, diffSnapshots } from '../backend/src/services/generator.js';

// execFile（不经 shell）：脚本路径作为单个 argv 传入，杜绝命令注入。
const execFileAsync = promisify(execFile);
const GENERATOR_TIMEOUT_MS = 120000;

const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.mp3', '.pdf', '.zip', '.rar'];
function isBinaryPath(p) {
  return BINARY_EXTS.includes(path.extname(String(p)).toLowerCase());
}
function skipDir(name) {
  return ['node_modules', '.git', '.edgeone', 'dist'].includes(name);
}

/* --------------------------------- 参数解析 --------------------------------- */

function printHelp() {
  console.log(`
ProtoBuddy 生成器外部执行环境 CLI

用法:
  node scripts/regenerate.js --project <id> --api <baseURL> --password <pw> [options]
  node scripts/regenerate.js --project <id> --api <baseURL> --token <ownerToken> [options]

必填:
  --project <id>      项目 id（如 1）
  --api <baseURL>     线上 API 根地址；EdgeOne 部署链接可整段粘贴（含
                      ?eo_token=...&eo_time=...，CLI 自动完成平台授权握手）
                      （如 https://protobuddy-app.edgeone.cool?eo_token=xx&eo_time=yy）
  --password <pw>     owner 操作密码（与 --token 二选一；验证后签发 8h 有效 token）
  --token <token>     已签发的 owner token（与 --password 二选一）

可选:
  --skip-deploy       只拉取→生成→回写，不触发重新部署
  --force             仅手动指定时也跳过生成器检查（默认：生成后自动带 force 部署）
  --workdir <dir>     本地工作目录（默认系统临时目录）
  --keep              结束后保留工作目录（默认清理）
  --verbose           打印执行细节
  --help              显示本帮助
`);
}

function parseArgs(argv) {
  const opts = {
    api: process.env.PB_API || 'http://localhost:3001',
    project: process.env.PB_PROJECT || '',
    password: process.env.PB_OWNER_PASSWORD || '',
    token: process.env.PB_OWNER_TOKEN || '',
    workdir: '',
    keep: false,
    skipDeploy: false,
    force: false,
    verbose: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--project': opts.project = next(); break;
      case '--api': opts.api = next().replace(/\/+$/, ''); break;
      case '--password': opts.password = next(); break;
      case '--token': opts.token = next(); break;
      case '--workdir': opts.workdir = next(); break;
      case '--keep': opts.keep = true; break;
      case '--skip-deploy': opts.skipDeploy = true; break;
      case '--force': opts.force = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        console.error(`[regenerate] 未知参数: ${a}（--help 查看用法）`);
        process.exit(2);
    }
  }
  return opts;
}

/* --------------------------------- HTTP 工具 --------------------------------- */

// EdgeOne Pages 平台对任意请求强制 eo_token/cookie 授权。URL 带 eo_token 时先做
// 两步握手换 cookie（GET health 跟随 302 拿 Set-Cookie），后续请求带 cookie。
let cookieJar = '';

function stripAuthQuery(api) {
  try {
    const u = new URL(api);
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return api.replace(/\/+$/, '');
  }
}

/**
 * 平台授权握手。返回 { base, authorized }：
 * - URL 含 eo_token/eo_time → GET health 跟随重定向换 cookie，base 剥离授权参数；
 * - URL 无 eo_token（本地 dev / 已授权环境）→ 原样返回，不握手。
 */
async function ensureAuthorized(api, verbose) {
  const base = api.replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (!u.searchParams.has('eo_token')) return { base, authorized: false };
    // 注意：不能用 `${base}/api/health` 字符串拼接——base 带 query 时会被拼到
    // query 后面变成 ?eo_token=...&eo_time=.../api/health（请求打到根路径）。
    // 用 URL 对象设置 pathname 保留 query。
    u.pathname = '/api/health';
    // redirect:'manual' 关键：跟随重定向会吞掉 302 的 Set-Cookie（fetch 不暴露
    // 中间响应头，而 curl -c jar 会存），必须手动读 302 响应拿授权 cookie。
    const res = await fetch(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(45000) });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    cookieJar = setCookies.map((c) => c.split(';')[0]).join('; ');
    if (verbose) console.log(`[regenerate] 平台授权: status=${res.status}, cookie=${cookieJar ? '已获取' : '无（可能已过期）'}`);
    return { base: stripAuthQuery(base), authorized: !!cookieJar };
  } catch (err) {
    throw new Error(`平台授权握手失败: ${err.message}`);
  }
}

async function apiFetch(url, options = {}, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { ...(options.headers || {}) };
    if (cookieJar) headers['cookie'] = cookieJar;
    const res = await fetch(url, { ...options, headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  } catch (err) {
    throw new Error(`请求失败 ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/* --------------------------------- 各阶段 --------------------------------- */

async function getOwnerToken(api, projectId, password, existingToken) {
  if (existingToken) return existingToken;
  if (!password) {
    throw new Error('需要 --password 或 --token（owner 操作密码 / 已签发的 owner token）');
  }
  const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/owner-auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (status !== 200 || !json?.ok) {
    throw new Error(`owner 验证失败 (${status}): ${json?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  console.log(`[regenerate] owner 验证通过，token 有效期 ${Math.round(json.expiresIn / 3600000)}h`);
  return json.token;
}

async function fetchFileList(api, projectId) {
  // 优先从存储驱动读取权威文件列表（files 表可能不完整）；
  // 失败则退回 files 表（兼容旧版本后端）。
  const stored = await apiFetch(`${api}/api/projects/${projectId}/storage-files`);
  if (stored.status === 200 && Array.isArray(stored.json?.paths)) {
    return stored.json.paths.map(p => ({ path: p }));
  }
  const legacy = await apiFetch(`${api}/api/projects/${projectId}/files`);
  if (legacy.status === 200 && Array.isArray(legacy.json)) return legacy.json;
  throw new Error(
    `拉取文件列表失败（storage-files HTTP ${stored.status} / files HTTP ${legacy.status}）: ` +
    `${(stored.json?.error || legacy.json?.error || '').slice(0, 300)}`
  );
}

async function restoreProject(workdir, api, projectId, files) {
  let count = 0;
  let skipped = 0;
  for (const f of files) {
    const rel = f?.path;
    if (!rel) continue;
    const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/files/${encodePath(rel)}`);
    if (status !== 200 || !json) { skipped++; continue; }
    const full = path.join(workdir, rel);
    if (!full.startsWith(workdir + path.sep)) continue; // 防路径穿越
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (json.binary) fs.writeFileSync(full, Buffer.from(json.data, 'base64'));
    else fs.writeFileSync(full, json.data, 'utf-8');
    count++;
  }
  if (skipped > 0) console.warn(`[regenerate] ${skipped} 个文件拉取失败，已跳过`);
  return count;
}

function findGenerator(workdir) {
  const hits = [];
  (function walk(dir, relBase = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        walk(path.join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name);
      } else {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (isGeneratorFile(rel)) hits.push(rel);
      }
    }
  })(workdir);
  hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return hits[0] || null;
}

async function runGenerator(workdir, script) {
  const scriptPath = path.resolve(workdir, String(script || ''));
  // 路径边界守卫：脚本必须位于工作目录内（防 ../ 逃逸执行任意文件）。
  if (!scriptPath.startsWith(path.resolve(workdir) + path.sep)) {
    throw new Error(`生成器脚本路径越界: ${script}`);
  }
  const scriptDir = path.dirname(scriptPath);
  if (!fs.existsSync(scriptPath)) throw new Error(`生成器脚本不存在: ${script}`);
  console.log(`[regenerate] 执行: python3 ${script} (cwd=${path.relative(workdir, scriptDir) || '.'})`);

  const python = process.env.GENERATOR_PYTHON || 'python3';
  const { stdout, stderr } = await execFileAsync(python, [scriptPath], {
    cwd: scriptDir,
    timeout: GENERATOR_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
  if (stdout.trim()) console.log(`[regenerate] 生成器输出: ${stdout.trim().slice(0, 1000)}`);
  if (stderr.trim()) console.warn(`[regenerate] 生成器 stderr: ${stderr.trim().slice(0, 1000)}`);
}

async function writeBack(api, projectId, token, workdir, changes) {
  const results = [];
  for (const c of changes) {
    if (c.action === 'removed') {
      const { status } = await apiFetch(`${api}/api/projects/${projectId}/files/${encodePath(c.path)}`, {
        method: 'DELETE',
        headers: { 'X-Owner-Token': token }
      });
      results.push({ path: c.path, action: c.action, status });
      continue;
    }
    const full = path.join(workdir, c.path);
    if (!fs.existsSync(full)) { results.push({ path: c.path, action: c.action, status: 0, error: '本地文件缺失' }); continue; }
    const content = isBinaryPath(c.path) ? fs.readFileSync(full).toString('base64') : fs.readFileSync(full, 'utf-8');
    const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': token },
      body: JSON.stringify({ path: c.path, content })
    });
    results.push({ path: c.path, action: c.action, status, error: status === 200 ? undefined : (json?.error || '') });
  }
  return results;
}

async function deploy(api, projectId, token, force) {
  const url = `${api}/api/projects/${projectId}/deploy${force ? '?force=1' : ''}`;
  const { status, json } = await apiFetch(url, {
    method: 'POST',
    headers: { 'X-Owner-Token': token }
  });
  return { status, json };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.project) {
    console.error('[regenerate] 缺少 --project <id>（--help 查看用法）');
    process.exit(2);
  }

  console.log(`[regenerate] 项目 #${opts.project} @ ${opts.api}`);

  // 0. EdgeOne 平台授权握手（URL 带 eo_token 时换 cookie）
  const auth = await ensureAuthorized(opts.api, opts.verbose);
  if (auth.authorized) opts.api = auth.base;

  // 1. owner 验证
  const token = await getOwnerToken(opts.api, opts.project, opts.password, opts.token);

  // 2. 拉取文件
  const workdir = opts.workdir || fs.mkdtempSync(path.join(os.tmpdir(), `pb-regenerate-${opts.project}-`));
  fs.mkdirSync(workdir, { recursive: true });
  console.log(`[regenerate] 工作目录: ${workdir}`);

  const files = await fetchFileList(opts.api, opts.project);
  console.log(`[regenerate] 拉取 ${files.length} 个文件…`);
  const restored = await restoreProject(workdir, opts.api, opts.project, files);
  console.log(`[regenerate] 已还原 ${restored} 个文件`);

  // 3. 检测并执行生成器
  const before = snapshotProject(workdir);
  const generator = findGenerator(workdir);
  if (generator) {
    console.log(`[regenerate] 检测到生成器脚本: ${generator}`);
    await runGenerator(workdir, generator);
  } else {
    console.log('[regenerate] 未检测到 Python 生成器脚本，跳过生成步骤');
  }
  const after = snapshotProject(workdir);
  const changes = diffSnapshots(before, after);
  const changesToWrite = changes.filter(c => c.path !== generator || c.action !== 'modified');

  if (changesToWrite.length === 0) {
    console.log('[regenerate] 生成后无产物变化（生成器未修改任何文件，或产物已最新）');
  } else {
    console.log(`[regenerate] 生成后产物变化（${changesToWrite.length}）:`);
    for (const c of changesToWrite) console.log(`  ${c.action.padEnd(8)} ${c.path}`);
  }

  // 4. 回写变化文件
  const writeResults = await writeBack(opts.api, opts.project, token, workdir, changesToWrite);
  const failedWrites = writeResults.filter(r => r.error || (r.status !== 200 && r.status !== 204));
  if (writeResults.length > 0) {
    console.log(`[regenerate] 回写线上存储: ${writeResults.length} 个文件（失败 ${failedWrites.length}）`);
  }
  for (const r of writeResults) {
    if (r.error || (r.status !== 200 && r.status !== 204)) {
      console.error(`  ✗ ${r.action} ${r.path} -> HTTP ${r.status} ${r.error || ''}`);
    } else if (opts.verbose) {
      console.log(`  ✓ ${r.action} ${r.path} -> HTTP ${r.status}`);
    }
  }
  if (failedWrites.length > 0) {
    throw new Error(`回写失败 ${failedWrites.length} 个文件，中止部署`);
  }

  // 5. 触发重新部署
  if (opts.skipDeploy) {
    console.log('[regenerate] --skip-deploy：跳过部署，产物已回写线上存储（可在评审页手动触发部署）');
  } else {
    // CLI 刚重新生成产物（或本就没有生成器），部署必须带 force 跳过生成器检查，
    // 否则线上函数又返回 regenerateRequired（死循环：部署永远被拦）。
    const deployForce = opts.force || !!generator;
    console.log(`[regenerate] 触发重新部署${deployForce ? '（产物已重新生成，跳过生成器检查）' : ''}…`);
    const { status, json } = await deploy(opts.api, opts.project, token, deployForce);
    console.log(`[regenerate] 部署接口响应 (HTTP ${status}):`);
    console.log(`  success=${json?.success}  method=${json?.method}  version=${json?.version}`);
    if (json?.regenerateRequired) {
      console.log(`  ⚠ 线上仍要求重新生成: ${json.message || ''}`);
    }
    if (json?.url) console.log(`  预览地址: ${json.url}`);
    if (json?.edgeone_url) console.log(`  EdgeOne 地址: ${json.edgeone_url}`);
    if (json?.status === 'deploying' || json?.method === 'edgeone_deploying') {
      console.log(`  部署进行中（deployment ${json?.deployment_id}），可轮询 GET /api/projects/${opts.project}/deploy-status?dep=${json?.deployment_id}`);
    }
    if (json?.generator) {
      console.log(`  生成器: ${json.generator.script}${json.generator.ran ? '（已执行）' : ''}${json.generator.forced ? '（force 跳过）' : ''}`);
      for (const c of (json.generator.changedFiles || [])) console.log(`    ${c}`);
    }
    if (status !== 200) {
      console.error(`  部署失败: ${json?.error || json?.message || ''}`);
      process.exitCode = 1;
    }
  }

  // 6. 清理
  if (!opts.keep) {
    fs.rmSync(workdir, { recursive: true, force: true });
    console.log('[regenerate] 已清理工作目录（--keep 保留）');
  } else {
    console.log(`[regenerate] 工作目录已保留: ${workdir}`);
  }
  console.log('[regenerate] 完成');
}

main().catch(err => {
  console.error(`[regenerate] 失败: ${err.message}`);
  process.exit(1);
});

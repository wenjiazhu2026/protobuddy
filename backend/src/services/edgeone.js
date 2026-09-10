import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getProjectDir, findEntryPoint, listProjectFiles, readFileContent } from './fileStorage.js';
import { isBlobMode } from '../config.js';
import { uploadAndDeploy, pollDeployment, getProjectUrl } from './makersApi.js';

const execFileAsync = promisify(execFile);

const DEPLOY_TIMEOUT = 180000; // 180s (first npx download of edgeone CLI can be slow)
const CLOUD_POLL_BUDGET_MS = 45000; // inline poll budget inside one function invocation

// EdgeOne Pages project names only allow a limited charset. This doubles as
// shell-metacharacter defense-in-depth: even though deployToEdgeOne now uses
// execFile (no shell), the name originates from a user-controlled project
// field, so it is validated before reaching any subprocess or API payload.
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

function safeProjectName(name, fallback) {
  const n = String(name || '').trim();
  return PROJECT_NAME_RE.test(n) ? n : fallback;
}

// Remove ANSI escape sequences (colors, cursor moves, etc.)
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}

// Extract the first HTTP(S) URL from text, preserving query strings.
function extractUrl(text) {
  const clean = stripAnsi(text);
  // Match http(s):// followed by allowed URL chars including ? & = % .
  const match = clean.match(/https?:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+/);
  return match ? match[0] : '';
}

function saveDeployLog(projectId, output) {
  const logDir = path.join(process.cwd(), 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `deploy-${projectId}-${Date.now()}.log`);
  fs.writeFileSync(logFile, output, 'utf-8');
  return logFile;
}

// ZIP extraction artefacts / tool metadata that must never reach the deployment.
const JUNK_SEGMENTS = ['__MACOSX', '.edgeone', '.git', '.svn', 'node_modules'];
function isJunkPath(rel) {
  const segments = rel.split('/');
  const base = segments[segments.length - 1] || '';
  return (
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base.startsWith('._') ||
    segments.some(s => JUNK_SEGMENTS.includes(s))
  );
}

/**
 * Build the deploy manifest for a project: EVERY file the file list shows,
 * mapped to the path it must have inside the deployment.
 *
 * The entry-point directory (ZIPs are often wrapped in e.g. `原型设计/`) is
 * flattened to the deployment root so index.html resolves at `/`. Files
 * OUTSIDE that directory used to be dropped entirely — they are now uploaded
 * with their original relative path.
 *
 * @returns {Promise<{entry:string, files:Array<{rel:string, deployPath:string}>, skipped:Array<{rel:string, reason:string}>}>}
 */
export async function planDeployPaths(projectId) {
  const entry = (await findEntryPoint(projectId)) || '';
  const prefix = entry ? `${entry}/` : '';
  const paths = (await listProjectFiles(projectId)) || [];

  // Entry subtree first: it owns the deployment root, so it wins path conflicts.
  const ordered = entry
    ? [...paths.filter(p => p.startsWith(prefix)), ...paths.filter(p => !p.startsWith(prefix))]
    : paths;

  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const rel of ordered) {
    if (!rel || rel.endsWith('/')) continue;
    if (isJunkPath(rel)) { skipped.push({ rel, reason: 'junk' }); continue; }
    const deployPath = prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
    if (!deployPath) { skipped.push({ rel, reason: 'empty' }); continue; }
    if (seen.has(deployPath)) { skipped.push({ rel, reason: 'conflict' }); continue; }
    seen.add(deployPath);
    files.push({ rel, deployPath });
  }
  return { entry, files, skipped };
}

const READ_CONCURRENCY = 6;
const READ_BUDGET_MS = 60000; // Cloud Functions cap at 120s — leave room for the COS upload + deployment API
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/**
 * Collect deployable files from the storage driver (blob mode) — all of them.
 * Reads are concurrent: a serial read of every project file can blow the 120s
 * function budget on larger prototypes.
 *
 * @returns {Promise<{files:Array<{path:string, body:Uint8Array}>, entry:string, total:number, skipped:Array}>}
 */
async function collectCloudFiles(projectId, { budgetMs = READ_BUDGET_MS } = {}) {
  const plan = await planDeployPaths(projectId);
  const items = plan.files;
  const deadline = Date.now() + budgetMs;
  const contents = new Array(items.length);
  let cursor = 0;
  let timedOut = false;

  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) { timedOut = true; return; }
      const i = cursor++;
      if (i >= items.length) return;
      contents[i] = await readFileContent(projectId, items[i].rel);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));

  if (timedOut && contents.some(c => c === undefined)) {
    const done = contents.filter(Boolean).length;
    throw new Error(
      `读取项目文件超时（云函数 120s 上限）：仅完成 ${done}/${items.length} 个。已中止部署，避免上传不完整的站点。`
    );
  }

  const files = [];
  const unreadable = [];
  let totalBytes = 0;
  for (let i = 0; i < items.length; i++) {
    const content = contents[i];
    if (!content) { unreadable.push({ rel: items[i].rel, reason: 'unreadable' }); continue; }
    const body = content.binary
      ? new Uint8Array(Buffer.from(content.data, 'base64'))
      : new TextEncoder().encode(content.data);
    totalBytes += body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`项目文件总大小超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限，已中止部署。`);
    }
    files.push({ path: items[i].deployPath, body });
  }
  return {
    files,
    entry: plan.entry,
    total: items.length,
    totalBytes,
    skipped: plan.skipped.concat(unreadable)
  };
}

/**
 * Materialise the deploy manifest into a staging directory so the CLI uploads
 * every project file from one root (the CLI deploys `cwd`, so running it
 * inside the entry subtree would silently ship only that subtree).
 *
 * Lives OUTSIDE the project dir — otherwise listProjectFiles() would pick the
 * staged copies up as project files on the next deploy.
 */
export async function stageDeployDir(projectId, projectDir, plan) {
  const stageDir = path.join(projectDir, '..', '..', '.pb-stage', String(projectId));
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const missing = [];
  for (const item of plan.files) {
    const content = await readFileContent(projectId, item.rel);
    if (!content) { missing.push(item.rel); continue; }
    const target = path.join(stageDir, item.deployPath);
    if (target !== stageDir && !target.startsWith(stageDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      content.binary ? Buffer.from(content.data, 'base64') : Buffer.from(content.data, 'utf-8')
    );
  }
  return { stageDir, missing };
}

/**
 * Deploy a project to EdgeOne Makers.
 * EdgeOne Makers is the DEFAULT hosting service; local static hosting is only a fallback
 * when EdgeOne is unavailable (no token / no network).
 *
 * Local mode uses the official CLI; blob mode (Makers Cloud Functions, read-only FS)
 * calls the Pages Open API directly via makersApi.js — same endpoints as the CLI.
 *
 * @param {object} project - Project record (has edgeone_token, edgeone_project_name)
 * @returns {Promise<{success, url, method, error?, log?, projectId?, deploymentId?}>}
 */
export async function deployToEdgeOne(project) {
  // Blob mode (Makers Cloud Functions): deploy via the Pages Open API.
  if (isBlobMode()) {
    if (!project.edgeone_token) {
      return {
        success: true,
        url: '',
        method: 'cloud_preview',
        log: 'No EdgeOne API token configured; preview served from /api/projects/:id/preview/.'
      };
    }
    try {
      console.log(`[edgeone] Deploying project ${project.id} to EdgeOne Makers via Pages API...`);
      // Validate the name (user-controlled) before it reaches the API payload.
      const projectName = safeProjectName(project.edgeone_project_name, `proto-${project.slug || project.id}`);
      const collected = await collectCloudFiles(project.id);
      const files = collected.files;
      const deployStats = {
        entry: collected.entry || '',
        uploaded: files.length,
        total: collected.total,
        bytes: collected.totalBytes,
        skipped: collected.skipped
      };
      if (files.length === 0) {
        return { success: false, url: '', method: 'none', error: 'Project has no files. Upload prototype files first.', deployStats };
      }
      console.log(`[edgeone] Deploy manifest: ${files.length}/${collected.total} files, ${(collected.totalBytes / 1024).toFixed(1)}KB, entry='${collected.entry || '/'}'${collected.skipped.length ? `, skipped: ${collected.skipped.map(s => `${s.rel}(${s.reason})`).join(', ')}` : ''}`);

      const { projectId, deploymentId } = await uploadAndDeploy({ token: project.edgeone_token, projectName, files });
      const polled = await pollDeployment({ token: project.edgeone_token, projectId, deploymentId, budgetMs: CLOUD_POLL_BUDGET_MS });

      if (!polled.done) {
        // Function may hit its time limit; the frontend continues polling deploy-status.
        return { success: true, url: '', method: 'edgeone_deploying', projectId, deploymentId, deployStats, log: `Deployment ${deploymentId} is building on EdgeOne (${files.length} files).` };
      }
      if (polled.status !== 'Success') {
        throw new Error(`EdgeOne deployment ended with status: ${polled.status}`);
      }

      const urlResult = await getProjectUrl(project.edgeone_token, projectId, {
        preferredDomain: project.custom_domain || undefined
      });
      const url = urlResult.url;
      console.log(`[edgeone] Deploy success: ${url}`);
      return {
        success: true, url, method: 'edgeone', projectId, deploymentId, deployStats,
        log: `Deployed ${files.length} files (entry='${collected.entry || '/'}'). ${url}`,
        customDomainBound: urlResult.customDomainBound,
        customDomainStatus: urlResult.customDomainStatus
      };
    } catch (err) {
      console.warn(`[edgeone] Pages API deploy failed: ${err.message}. Falling back to function preview.`);
      return {
        success: true,
        url: '',
        method: 'cloud_preview',
        error: err.message,
        log: `EdgeOne Pages API deploy failed: ${err.message}. Preview served from the function.`
      };
    }
  }

  // NOTE: getProjectDir / findEntryPoint go through fileStorage.js's async
  // `wrap()` and therefore return Promises — they MUST be awaited. Forgetting
  // the await made path.join() receive a Promise and threw
  // `The "path" argument must be of type string` on every local redeploy
  // (blob mode took the Pages-API branch above, so the bug only bit local dev).
  const projectDir = await getProjectDir(project.id);
  const plan = await planDeployPaths(project.id);

  // Verify the manifest has content (ALL project files, not just the entry subtree)
  if (plan.files.length === 0) {
    return {
      success: false,
      url: '',
      method: 'none',
      error: 'Project directory is empty. Upload prototype files first.'
    };
  }

  // Stage every project file under one root: the entry subtree flattened to the
  // root (so index.html resolves at `/`), everything else at its own path.
  const { stageDir, missing: stageMissing } = await stageDeployDir(project.id, projectDir, plan);
  const deployDir = stageDir;
  const deployStats = {
    entry: plan.entry || '',
    uploaded: plan.files.length - stageMissing.length,
    total: plan.files.length,
    skipped: plan.skipped.concat(stageMissing.map(rel => ({ rel, reason: 'unreadable' })))
  };
  console.log(`[edgeone] Staged ${plan.files.length} files at ${stageDir} (entry='${plan.entry || '/'}')${stageMissing.length ? `, unreadable: ${stageMissing.join(', ')}` : ''}`);

  // Default path: EdgeOne Makers hosting (requires API token)
  if (project.edgeone_token) {
    try {
      console.log(`[edgeone] Deploying project ${project.id} to EdgeOne Makers...`);

      // Validate the name (user-controlled) against a safe charset, then run
      // the CLI with execFile + an argument array — NO shell interpolation, so
      // a crafted project name can never break out into command execution.
      const projectName = safeProjectName(project.edgeone_project_name, `proto-${project.slug || project.id}`);

      const { stdout, stderr } = await execFileAsync(
        'npx',
        ['--yes', 'edgeone', 'makers', 'deploy', '.', '-n', projectName, '-t', project.edgeone_token, '-e', 'production'],
        {
          cwd: deployDir,
          timeout: DEPLOY_TIMEOUT,
          maxBuffer: 1024 * 1024 * 5
        }
      );

      const output = stdout + '\n' + stderr;
      const logFile = saveDeployLog(project.id, output);

      // Try to extract URL from output
      const url = extractUrl(output);

      if (url) {
        console.log(`[edgeone] Deploy success: ${url}`);
        return {
          success: true,
          url,
          method: 'edgeone',
          deployStats,
          log: output,
          logFile
        };
      }

      // CLI ran but no URL found - log everything and throw so caller can decide
      console.log(`[edgeone] CLI ran but no URL in output. Output:\n${output.slice(0, 2000)}`);
      throw new Error(`EdgeOne CLI ran but returned no URL. Full log saved to: ${logFile}`);
    } catch (err) {
      console.warn(`[edgeone] EdgeOne CLI deploy failed: ${err.message}. Falling back to local hosting.`);
      return {
        success: false,
        url: '',
        method: 'edgeone_failed',
        deployStats,
        error: err.message,
        log: err.stdout || err.stderr || err.message,
        logFile: err.logFile || saveDeployLog(project.id, err.stdout || err.stderr || err.message)
      };
    }
  } else {
    console.warn('[edgeone] No EdgeOne API token configured. Using local static hosting. Set the token in Settings to enable EdgeOne Makers hosting.');
  }

  // Fallback: local static hosting
  return {
    success: true,
    url: '', // Will be constructed by the caller using /api/projects/:id/preview
    method: 'local',
    deployStats,
    log: 'Deployed via local static hosting (EdgeOne CLI unavailable or not configured).'
  };
}

/**
 * Build the local preview URL for a project.
 */
export function buildLocalPreviewUrl(baseUrl, projectId, version) {
  return `${baseUrl}/api/projects/${projectId}/preview/${version ? `?v=${version}` : ''}`;
}

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

/**
 * Collect deployable files from the storage driver (blob mode).
 * Deploys only the entry-point subtree (e.g. ZIPs wrapped in `原型设计/`),
 * stripping the wrapper dir so index.html lands at the deployment root.
 */
async function collectCloudFiles(projectId) {
  const entry = (await findEntryPoint(projectId)) || '';
  const prefix = entry ? `${entry}/` : '';
  const paths = await listProjectFiles(projectId);
  const files = [];
  for (const p of paths) {
    if (!prefix || p.startsWith(prefix)) {
      const rel = prefix ? p.slice(prefix.length) : p;
      if (!rel || rel.endsWith('/')) continue;
      const content = await readFileContent(projectId, p);
      if (!content) continue;
      const body = content.binary
        ? new Uint8Array(Buffer.from(content.data, 'base64'))
        : new TextEncoder().encode(content.data);
      files.push({ path: rel, body });
    }
  }
  return files;
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
      const files = await collectCloudFiles(project.id);
      if (files.length === 0) {
        return { success: false, url: '', method: 'none', error: 'Project has no files. Upload prototype files first.' };
      }

      const { projectId, deploymentId } = await uploadAndDeploy({ token: project.edgeone_token, projectName, files });
      const polled = await pollDeployment({ token: project.edgeone_token, projectId, deploymentId, budgetMs: CLOUD_POLL_BUDGET_MS });

      if (!polled.done) {
        // Function may hit its time limit; the frontend continues polling deploy-status.
        return { success: true, url: '', method: 'edgeone_deploying', projectId, deploymentId, log: `Deployment ${deploymentId} is building on EdgeOne.` };
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
        success: true, url, method: 'edgeone', projectId, deploymentId,
        log: `Deployed ${files.length} files. ${url}`,
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
  const entrySubdir = await findEntryPoint(project.id);
  const deployDir = entrySubdir ? path.join(projectDir, entrySubdir) : projectDir;

  // Verify directory has content
  if (!fs.existsSync(deployDir) || fs.readdirSync(deployDir).length === 0) {
    return {
      success: false,
      url: '',
      method: 'none',
      error: 'Project directory is empty. Upload prototype files first.'
    };
  }

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
    log: 'Deployed via local static hosting (EdgeOne CLI unavailable or not configured).'
  };
}

/**
 * Build the local preview URL for a project.
 */
export function buildLocalPreviewUrl(baseUrl, projectId, version) {
  return `${baseUrl}/api/projects/${projectId}/preview/${version ? `?v=${version}` : ''}`;
}

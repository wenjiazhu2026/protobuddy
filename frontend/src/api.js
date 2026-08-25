// EdgeOne Makers mounts the Express Cloud Function at /express (framework mode),
// so the deployed build must use /express/api. Local dev keeps the default /api
// (proxied to the backend by Vite).
export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * Owner verification session token (per project, sessionStorage so it clears
 * when the browser tab/session ends). Server-side expiry is enforced by the
 * token signature (OWNER_AUTH_TTL_MS).
 */
const OWNER_TOKEN_PREFIX = 'pb_owner_token_';
export function getOwnerToken(projectId) {
  try { return sessionStorage.getItem(OWNER_TOKEN_PREFIX + projectId) || ''; } catch { return ''; }
}
export function setOwnerToken(projectId, token) {
  try { sessionStorage.setItem(OWNER_TOKEN_PREFIX + projectId, token); } catch {}
}
export function clearOwnerToken(projectId) {
  try { sessionStorage.removeItem(OWNER_TOKEN_PREFIX + projectId); } catch {}
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const opts = {
    headers: {},
    ...options
  };

  // Owner-gated calls attach the verified session token.
  if (opts.ownerToken) {
    opts.headers['X-Owner-Token'] = opts.ownerToken;
  }

  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = data.error || '';
    err.status = res.status;
    err.lock = data.lock || null;
    err.remainingAttempts = data.remainingAttempts;
    // Apply-plan conflicts (409) carry the per-change failure list + deploy error.
    err.errors = data.errors || null;
    err.deployError = data.deployError || '';
    err.regenerateRequired = data.regenerateRequired || null;
    throw err;
  }

  return data;
}

export const api = {
  // Projects
  listProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  // Owner maintenance operations: pass the verified owner token to skip re-auth.
  updateProject: (id, data, ownerToken) => request(`/projects/${id}`, { method: 'PUT', body: data, ownerToken }),
  deleteProject: (id, ownerToken) => request(`/projects/${id}`, { method: 'DELETE', ownerToken }),
  uploadPrototype: (id, file, ownerToken) => {
    const formData = new FormData();
    formData.append('type', 'zip');
    formData.append('file', file);
    return request(`/projects/${id}/upload`, { method: 'POST', body: formData, ownerToken });
  },
  /**
   * Upload a prototype via three supported methods:
   *   type='zip'    - single ZIP package (File)
   *   type='html'   - single index.html (File)
   *   type='folder' - multiple files with relative paths (Array<{file, relPath}>)
   */
  uploadPrototypeFiles: (id, type, payload, ownerToken) => {
    const formData = new FormData();
    formData.append('type', type);
    if (type === 'folder') {
      for (const item of payload) {
        formData.append('files', item.file);
        formData.append('paths', item.relPath);
      }
    } else {
      formData.append('file', payload);
    }
    return request(`/projects/${id}/upload`, { method: 'POST', body: formData, ownerToken });
  },

  // Files (write/delete are owner maintenance operations)
  listFiles: (id) => request(`/projects/${id}/files`),
  readFile: (id, filePath) => request(`/projects/${id}/files/${filePath}`),
  writeFile: (id, path, content, ownerToken) => request(`/projects/${id}/files`, { method: 'POST', body: { path, content }, ownerToken }),
  deleteFile: (id, filePath, ownerToken) => request(`/projects/${id}/files/${filePath}`, { method: 'DELETE', ownerToken }),

  // Deploy (owner operations). force=1 跳过生成器检查（确认产物已最新时使用）
  deploy: (id, ownerToken, force) => request(`/projects/${id}/deploy${force ? '?force=1' : ''}`, { method: 'POST', ownerToken }),
  deployStatus: (id, depId) => request(`/projects/${id}/deploy-status${depId ? `?dep=${depId}` : ''}`),
  listDeployments: (id) => request(`/projects/${id}/deployments`),
  setPreviewUrl: (id, url, ownerToken) => request(`/projects/${id}/preview-url`, { method: 'POST', body: { url }, ownerToken }),

  // Owner password verification
  verifyOwnerPassword: (id, password) => request(`/projects/${id}/owner-auth/verify`, { method: 'POST', body: { password } }),
  ownerAuthStatus: (id) => request(`/projects/${id}/owner-auth/status`),

  // Annotations
  listAnnotations: (id, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/projects/${id}/annotations${query ? '?' + query : ''}`);
  },
  createAnnotation: (id, data) => request(`/projects/${id}/annotations`, { method: 'POST', body: data }),
  updateAnnotation: (id, annId, data, ownerToken) => request(`/projects/${id}/annotations/${annId}`, { method: 'PUT', body: data, ownerToken }),
  deleteAnnotation: (id, annId, ownerToken) => request(`/projects/${id}/annotations/${annId}`, { method: 'DELETE', ownerToken }),

  // Plans (review/apply are owner operations; generation is open to all roles)
  generatePlan: (id, opts = {}) => request(`/projects/${id}/plan${opts.force ? '?force=1' : ''}`, { method: 'POST' }),
  listPlans: (id) => request(`/projects/${id}/plans`),
  getPlan: (planId) => request(`/projects/plans/${planId}`),
  approvePlan: (planId, ownerToken) => request(`/projects/plans/${planId}/approve`, { method: 'POST', ownerToken }),
  rejectPlan: (planId, ownerToken) => request(`/projects/plans/${planId}/reject`, { method: 'POST', ownerToken }),
  approveChange: (planId, changeId, ownerToken) => request(`/projects/plans/${planId}/changes/${changeId}/approve`, { method: 'POST', ownerToken }),
  rejectChange: (planId, changeId, ownerToken) => request(`/projects/plans/${planId}/changes/${changeId}/reject`, { method: 'POST', ownerToken }),
  applyPlan: (planId, ownerToken) => request(`/projects/plans/${planId}/apply`, { method: 'POST', ownerToken }),
  rollbackPlan: (planId, ownerToken) => request(`/projects/plans/${planId}/rollback`, { method: 'POST', ownerToken }),

  // Tasks (task list module)
  listTasks: (id, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/projects/${id}/tasks${query ? '?' + query : ''}`);
  },
  getTask: (id, taskId) => request(`/projects/${id}/tasks/${taskId}`),
  createTask: (id, data, ownerToken) => request(`/projects/${id}/tasks`, { method: 'POST', body: data, ownerToken }),
  updateTask: (id, taskId, data, ownerToken) => request(`/projects/${id}/tasks/${taskId}`, { method: 'PUT', body: data, ownerToken }),
  deleteTask: (id, taskId, ownerToken) => request(`/projects/${id}/tasks/${taskId}`, { method: 'DELETE', ownerToken }),
  batchDeleteTasks: (id, taskIds, ownerToken) => request(`/projects/${id}/tasks/batch-delete`, { method: 'POST', body: { task_ids: taskIds }, ownerToken }),
  batchMoveTasks: (id, taskIds, status, ownerToken) => request(`/projects/${id}/tasks/batch-move`, { method: 'POST', body: { task_ids: taskIds, status }, ownerToken }),
  generateTasks: (id, config, ownerToken) => request(`/projects/${id}/tasks/generate`, { method: 'POST', body: { config }, ownerToken }),
  generateTasksPreview: (id, config) => request(`/projects/${id}/tasks/generate/preview`, { method: 'POST', body: { config } }),
  mergeTasks: (id, taskId, taskIds, ownerToken) => request(`/projects/${id}/tasks/${taskId}/merge`, { method: 'POST', body: { task_ids: taskIds }, ownerToken }),
  splitTask: (id, taskId, parts, ownerToken) => request(`/projects/${id}/tasks/${taskId}/split`, { method: 'POST', body: { parts }, ownerToken }),
  getTaskConfig: (id) => request(`/projects/${id}/tasks/config`),
  updateTaskConfig: (id, data, ownerToken) => request(`/projects/${id}/tasks/config`, { method: 'PUT', body: data, ownerToken }),
  getGitlabConfig: (id) => request(`/projects/${id}/tasks/gitlab-config`),
  updateGitlabConfig: (id, data, ownerToken) => request(`/projects/${id}/tasks/gitlab-config`, { method: 'PUT', body: data, ownerToken }),
  testGitlab: (id, ownerToken) => request(`/projects/${id}/tasks/gitlab-test`, { method: 'POST', ownerToken }),
  exportTasks: async (id, format = 'json') => {
    // Raw text download: JSON/CSV responses are NOT JSON-wrapped, so bypass the
    // JSON-parsing request() wrapper.
    const res = await fetch(`${API_BASE}/projects/${id}/tasks/export?format=${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.text();
  },
  pushTasksToGitlab: (id, taskIds, ownerToken) => request(`/projects/${id}/tasks/export/gitlab`, { method: 'POST', body: { task_ids: taskIds }, ownerToken }),
  syncTaskAnnotations: (id) => request(`/projects/${id}/tasks/sync-annotations`, { method: 'POST' }),

  // Health
  health: () => request('/health'),
};

// Build preview URL for iframe (same-origin, served by the Express function)
export function getPreviewUrl(projectId, baseUrl = '') {
  return `${baseUrl}${API_BASE}/projects/${projectId}/preview/`;
}

/**
 * 构造「外部执行环境重新生成」的 CLI 命令（供前端复制）。
 * 优先用浏览器当前 URL（含 eo_token 授权参数，EdgeOne 平台强制授权）拼接；
 * 服务端 hint 在 EdgeOne 上可能拿到内部 SCF host（含 qcloudteo.com 标记），
 * 仅在本地 dev（无内部标记）时使用，保证用户复制到的命令始终可执行。
 */
export function buildRegenerateCmd(projectId, serverHint) {
  if (serverHint && !/qcloudteo|pages-scf/i.test(serverHint)) return serverHint;
  let base = typeof window !== 'undefined' ? window.location.origin : '';
  if (typeof window !== 'undefined' && /eo_token=/.test(window.location.search)) {
    base += window.location.search;
  }
  return `node scripts/regenerate.js --project ${projectId} --api ${base}`;
}

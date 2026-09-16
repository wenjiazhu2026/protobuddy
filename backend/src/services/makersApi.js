/**
 * EdgeOne Makers (Pages) Open API client.
 *
 * Deploys prototypes from inside the Makers Cloud Function (read-only FS, no
 * npx) by calling the same REST API the `edgeone` CLI uses:
 *   POST https://pages-api.cloud.tencent.com/v1
 *   Authorization: Bearer <api token>
 *   Body: { Action: "<Action>", ...params }
 *
 * Flow (mirrors the CLI):
 *   1. DescribePagesProjects (by Name) / CreatePagesProject
 *   2. DescribePagesCosTempToken -> COS temp credentials + TargetPath
 *   3. PUT each file to {Bucket}.cos.accelerate.myqcloud.com/{TargetPath}/{rel}
 *      (COS XML API, manual signature - no SDK)
 *   4. CreatePagesDeployment (DistType=Folder)
 *   5. Poll DescribePagesDeployments until terminal status
 *   6. DescribePagesProjects -> PresetDomain; DescribePagesEncipherToken
 *      -> eo_token for the final access URL (non-TLD domains).
 */

import crypto from 'crypto';

const API_BASES = ['https://pages-api.cloud.tencent.com/v1', 'https://pages-api.edgeone.ai/v1'];
const POLL_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Acceleration area (加速区域)
// ---------------------------------------------------------------------------
// The area is fixed AT CREATE TIME and cannot be changed afterwards. It decides
// whether a custom domain may be bound without ICP filing (工信部备案):
//   overseas          全球可用区（不含中国大陆）→ 绑自定义域名**无需**备案
//   global            全球可用区（含中国大陆）  → 需备案
//   chinese-mainland  中国大陆可用区            → 需备案
// Verified against edgeone@1.6.40: `deploy -a/--area` choices are
// global|overseas with default `global`, and the chosen value is passed
// straight through as the `Area` field of CreatePagesProject.
//
// Default is `overseas` so a newly auto-created project can serve a custom
// domain without filing. Override with EDGEONE_AREA=global when the account
// actually has ICP-filed domains and wants mainland acceleration.
const DEFAULT_AREA = 'overseas';
const AREA_ALIASES = {
  overseas: 'overseas',
  global: 'global',
  'chinese-mainland': 'chinese-mainland',
  china: 'chinese-mainland',
  mainland: 'chinese-mainland'
};
// Only areas known to EXCLUDE Chinese mainland are filing-free. Treating every
// other (including unrecognised) value as filing-required is the safe default:
// a spurious warning costs a log line, whereas a missed one costs a rejected
// custom-domain binding after the project area is already frozen.
const FILING_FREE_AREAS = new Set(['overseas']);

/**
 * Resolve the acceleration area to use for NEW projects (default `overseas`).
 * Strict: the result is sent straight to CreatePagesProject as `Area`, so an
 * unrecognised EDGEONE_AREA value must never reach the API — it falls back to
 * the default instead of failing project creation with an invalid enum.
 */
export function resolveArea(raw = process.env.EDGEONE_AREA) {
  const value = String(raw ?? '').trim().toLowerCase();
  return AREA_ALIASES[value] || DEFAULT_AREA;
}

/** Normalise an area string (alias -> canonical). Unknown values pass through. */
function canonicalArea(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return AREA_ALIASES[value] || value;
}

/**
 * True when the area includes Chinese mainland, i.e. a custom domain needs ICP filing.
 * An empty area returns false (nothing to judge); any unrecognised value returns true.
 */
export function areaRequiresFiling(area) {
  const canon = canonicalArea(area);
  return canon ? !FILING_FREE_AREAS.has(canon) : false;
}

let resolvedBase = null;

/** POST one action to the Pages API. Returns parsed JSON (Code === 0 on success). */
export async function callApi(token, action, data = {}) {
  const bases = resolvedBase ? [resolvedBase] : API_BASES;
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ Action: action, ...data })
      });
      if (!res.ok) throw new Error(`API request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      if (json.Code !== 0) {
        const respErr = json.Data?.Response?.Error;
        throw new Error(respErr?.Message ? `${respErr.Code}: ${respErr.Message}` : `API error: ${json.Message || json.Code}`);
      }
      resolvedBase = base;
      return json;
    } catch (err) {
      // Auth errors are fatal; network errors may be base-region related -> try next base
      if (/Bearer|token|auth/i.test(err.message) && bases.length === 1) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('Pages API unreachable');
}

/**
 * Look up an existing project by name. READ-ONLY — returns null when absent.
 * Kept separate from getOrCreateProject so diagnostics (domain status checks)
 * never create a project as a side effect.
 */
export async function findProjectByName(token, name) {
  const res = await callApi(token, 'DescribePagesProjects', {
    Filters: [{ Name: 'Name', Values: [name] }],
    Offset: 0,
    Limit: 10,
    OrderBy: 'CreatedOn'
  });
  return (res.Data?.Response?.Projects || [])[0] || null;
}

/** Find a project by name, or create it. Returns { projectId, name, area, filingRequired }. */
export async function getOrCreateProject(token, name) {
  let proj = await findProjectByName(token, name);
  if (!proj) {
    // Create with an area that excludes Chinese mainland by default, so the
    // custom domain can be bound without ICP filing.
    const area = resolveArea();
    console.log(`[makersApi] Creating EdgeOne project '${name}' with acceleration area '${area}' (ICP filing required: ${areaRequiresFiling(area)})`);
    await callApi(token, 'CreatePagesProject', {
      Name: name,
      Provider: 'Upload',
      Channel: 'Custom',
      Area: area,
      Source: 'protobuddy'
    });
    await new Promise(r => setTimeout(r, 2000));
    proj = await findProjectByName(token, name);
    if (!proj) throw new Error(`Failed to create project ${name}`);
  }
  if (proj.Provider && proj.Provider !== 'Upload') {
    throw new Error(`Project ${name} exists but Provider is '${proj.Provider}' (only Upload projects are supported)`);
  }

  // The area is immutable after creation, so an existing project that includes
  // Chinese mainland cannot be "fixed" here — warn instead, otherwise the owner
  // only discovers it when binding a custom domain is rejected for ICP filing.
  const area = proj.Area || proj.area || '';
  const filingRequired = areaRequiresFiling(area);
  if (filingRequired) {
    console.warn(
      `[makersApi] Project '${name}' acceleration area is '${area}' (includes Chinese mainland): ` +
      `binding a custom domain requires ICP filing. To serve a non-filed domain, create a new project with EDGEONE_AREA=overseas.`
    );
  }

  return { projectId: proj.ProjectId, name: proj.Name, area, filingRequired };
}

// ---------------------------------------------------------------------------
// COS XML API signature (sha1/hmac-sha1, no SDK)
// ---------------------------------------------------------------------------

function sha1hex(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function hmacSha1hex(key, s) { return crypto.createHmac('sha1', key).update(s).digest('hex'); }
function camSafeUrlEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

/**
 * Build the COS XML API Authorization string (sha1/hmac-sha1).
 * Signs the host + x-cos-security-token headers, as the official SDK does
 * for temporary credentials. `headers` values must be strings.
 */
function cosAuthorization({ method, pathname, host, sessionToken, secretId, secretKey }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 600}`;
  const signKey = hmacSha1hex(secretKey, keyTime);

  const headers = { host };
  if (sessionToken) headers['x-cos-security-token'] = sessionToken;

  const headerKeys = Object.keys(headers).sort();
  const headerList = headerKeys.join(';');
  // COS expects `k1=v1&k2=v2` with NO trailing separator
  const headerStr = headerKeys.map(k => `${k}=${headers[k]}`).join('&');

  // Slashes in the pathname must stay unencoded (camSafeUrlEncode(key, '/'))
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`;
  const signature = hmacSha1hex(signKey, stringToSign);

  return (
    `q-sign-algorithm=sha1&q-ak=${secretId}` +
    `&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`
  );
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  xml: 'application/xml', mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf'
};

/** PUT one object into the temp COS bucket. `body` is Uint8Array. */
async function cosPut(bucket, key, body, contentType, creds) {
  const host = `${bucket}.cos.accelerate.myqcloud.com`;
  // Signature uses the DECODED path (Chinese filenames sign as raw UTF-8),
  // while the request URL uses the percent-encoded path.
  const rawPath = '/' + key;
  const encPath = '/' + key.split('/').map(camSafeUrlEncode).join('/');
  const authorization = cosAuthorization({
    method: 'PUT',
    pathname: rawPath,
    host,
    sessionToken: creds.Token,
    secretId: creds.TmpSecretId,
    secretKey: creds.TmpSecretKey
  });
  const headers = {
    Authorization: authorization,
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength)
  };
  if (creds.Token) headers['x-cos-security-token'] = creds.Token;
  const res = await fetch(`https://${host}${encPath}`, { method: 'PUT', headers, body });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`COS PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Upload files and create a deployment.
 * @param {object} opts
 * @param {string} opts.token Makers API token
 * @param {string} opts.projectName target Makers project name
 * @param {Array<{path:string, body:Uint8Array}>} opts.files relative paths -> content
 * @returns {Promise<{projectId:string, deploymentId:string, area:string, filingRequired:boolean}>}
 */
export async function uploadAndDeploy({ token, projectName, files }) {
  if (!files || files.length === 0) throw new Error('No files to deploy');

  const { projectId, area, filingRequired } = await getOrCreateProject(token, projectName);

  const tokRes = await callApi(token, 'DescribePagesCosTempToken', { ProjectId: projectId });
  const cos = tokRes.Data?.Response || {};
  const { Bucket, Region, TargetPath, Credentials } = cos;
  if (!Bucket || !Region || !TargetPath || !Credentials) {
    throw new Error('COS temp token response missing Bucket/Region/TargetPath/Credentials');
  }

  // Sequential upload with limited concurrency (prototypes are small)
  const CONCURRENCY = 5;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(f => {
      const ext = (f.path.split('.').pop() || '').toLowerCase();
      return cosPut(Bucket, `${TargetPath}/${f.path}`, f.body, CONTENT_TYPES[ext] || 'application/octet-stream', Credentials);
    }));
  }

  const depRes = await callApi(token, 'CreatePagesDeployment', {
    ProjectId: projectId,
    ViaMeta: 'Upload',
    Provider: 'Upload',
    Env: 'Production',
    DistType: 'Folder',
    TempBucketPath: TargetPath,
    BuildFrom: 'CLI'
  });
  const deploymentId = depRes.Data?.Response?.DeploymentId;
  if (!deploymentId) throw new Error('CreatePagesDeployment returned no DeploymentId');
  return { projectId, deploymentId, area, filingRequired };
}

/**
 * Poll a deployment until terminal status or budget exhausted.
 * @returns {Promise<{done:boolean, status:string}>}
 */
export async function pollDeployment({ token, projectId, deploymentId, budgetMs = 50000 }) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await callApi(token, 'DescribePagesDeployments', {
        ProjectId: projectId, Offset: 0, Limit: 50, OrderBy: 'CreatedOn', Order: 'Desc'
      });
      const dep = (res.Data?.Response?.Deployments || []).find(d => d.DeploymentId === deploymentId);
      if (dep && !['Process', 'Pending'].includes(dep.Status)) {
        return { done: true, status: dep.Status };
      }
    } catch { /* transient - keep polling */ }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { done: false, status: 'deploying' };
}

/** Single status check (for the frontend polling endpoint). */
export async function checkDeployment({ token, projectId, deploymentId }) {
  const res = await callApi(token, 'DescribePagesDeployments', {
    ProjectId: projectId, Offset: 0, Limit: 50, OrderBy: 'CreatedOn', Order: 'Desc'
  });
  const dep = (res.Data?.Response?.Deployments || []).find(d => d.DeploymentId === deploymentId);
  if (!dep) return { done: false, status: 'deploying' };
  if (['Process', 'Pending'].includes(dep.Status)) return { done: false, status: 'deploying' };
  return { done: true, status: dep.Status };
}

/**
 * Resolve the public URL of a finished deployment (mirrors the CLI):
 * preferred custom domain > any custom domain (Pass) > preset domain (IsTld=1, no token) > preset domain + eo_token.
 *
 * @param {string} token Makers API token
 * @param {string} projectId EdgeOne Pages project ID
 * @param {object} [opts]
 * @param {string} [opts.preferredDomain] - User-configured custom domain to prioritise
 * @returns {Promise<{url:string, customDomainBound?:boolean, customDomainStatus?:string}>}
 */
export async function getProjectUrl(token, projectId, opts = {}) {
  const res = await callApi(token, 'DescribePagesProjects', {
    Filters: [{ Name: 'ProjectId', Values: [projectId] }], Offset: 0, Limit: 10, OrderBy: 'CreatedOn'
  });
  const proj = (res.Data?.Response?.Projects || [])[0];
  if (!proj) throw new Error('Failed to describe project after deploy');

  const allCustom = proj.CustomDomains || [];

  console.log(`[makersApi] getProjectUrl: projectId=${projectId}, preferredDomain=${opts.preferredDomain || '(none)'}`);
  console.log(`[makersApi] CustomDomains: ${JSON.stringify(allCustom.map(d => ({ Domain: d.Domain, Status: d.Status })))}`);
  console.log(`[makersApi] PresetDomain=${proj.PresetDomain}, IsTld=${proj.IsTld}`);

  // 1. If user configured a preferred domain, try to match it first
  if (opts.preferredDomain) {
    const norm = opts.preferredDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const matched = allCustom.find(d =>
      (d.Domain || '').toLowerCase() === norm && isDomainActive(d)
    );
    if (matched) {
      console.log(`[makersApi] Preferred domain matched (active): ${matched.Domain}`);
      return { url: `https://${matched.Domain}`, customDomainBound: true };
    }

    // Domain configured but not yet active — report status so frontend can show guidance
    const pending = allCustom.find(d => (d.Domain || '').toLowerCase() === norm);
    if (pending) {
      console.log(`[makersApi] Preferred domain found but not active (status=${pending.Status || 'unknown'}), falling back`);
      // Fall through to other domains / preset, but include status info
      const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
      return { ...fallback, customDomainBound: false, customDomainStatus: pending.Status || 'unknown' };
    }
    // Domain not found in EdgeOne at all — user hasn't bound it yet
    console.log(`[makersApi] Preferred domain '${norm}' NOT FOUND in EdgeOne custom domains, falling back`);
    const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
    return { ...fallback, customDomainBound: false, customDomainStatus: 'not_bound' };
  }

  // 2. No preferred domain — use any Pass custom domain, then preset
  const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
  console.log(`[makersApi] No preferred domain, resolved: ${fallback.url}`);
  return fallback;
}

/**
 * Query EdgeOne for all custom domains bound to a project (diagnostic).
 * @returns {Promise<{presetDomain:string, isTld:boolean, accelerationArea:string, filingRequired:boolean, customDomains:Array<{Domain:string,Status:string}>}>}
 */
export async function describeProjectDomains(token, projectId) {
  const res = await callApi(token, 'DescribePagesProjects', {
    Filters: [{ Name: 'ProjectId', Values: [projectId] }], Offset: 0, Limit: 10, OrderBy: 'CreatedOn'
  });
  const proj = (res.Data?.Response?.Projects || [])[0];
  if (!proj) throw new Error('Project not found in EdgeOne');
  const area = proj.Area || proj.area || '';
  return {
    presetDomain: proj.PresetDomain || '',
    isTld: proj.IsTld === 1,
    accelerationArea: area,
    filingRequired: areaRequiresFiling(area),
    customDomains: (proj.CustomDomains || []).map(d => ({ Domain: d.Domain, Status: d.Status || '(missing — treated as active)' }))
  };
}

/**
 * Check if a custom domain entry is "active" (usable as a URL).
 * EdgeOne API sometimes omits the Status field entirely for bound domains,
 * so we treat missing/empty Status as valid (the domain is in the list = bound).
 */
function isDomainActive(d) {
  const s = d.Status;
  return !s || s === 'Pass' || s === 'Active';
}
const PREFERRED_DOMAIN_SUFFIX = '.20140107.xyz';

/**
 * Pick the best Pass custom domain, prioritising the configured suffix pattern.
 * Priority: Pass domain matching *.20140107.xyz → any Pass domain → null.
 */
function pickBestCustomDomain(allCustom) {
  const passDomains = allCustom.filter(d => isDomainActive(d));
  if (passDomains.length === 0) return null;
  // Prefer domains ending with the suffix (e.g. cis2.20140107.xyz)
  const preferred = passDomains.find(d => (d.Domain || '').toLowerCase().endsWith(PREFERRED_DOMAIN_SUFFIX));
  return preferred || passDomains[0];
}

/** Resolve URL from any Pass custom domain or preset domain (extracted helper). */
async function resolvePresetOrAnyCustom(token, proj, allCustom) {
  const best = pickBestCustomDomain(allCustom);
  if (best) return { url: `https://${best.Domain}` };

  const domain = proj.PresetDomain;
  if (!domain) throw new Error('Project has no PresetDomain');

  if (proj.IsTld === 1) return { url: `https://${domain}` };

  const enc = await callApi(token, 'DescribePagesEncipherToken', { Text: domain });
  const { Token, Timestamp } = enc.Data?.Response || {};
  if (!Token || !Timestamp) throw new Error('DescribePagesEncipherToken returned no token');
  return { url: `https://${domain}?eo_token=${Token}&eo_time=${Timestamp}` };
}

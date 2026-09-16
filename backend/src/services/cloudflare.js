/**
 * Cloudflare DNS API v4 client.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Protobuddy project is served under a custom domain (e.g. cis2.20140107.xyz)
 * whose DNS lives in Cloudflare. EdgeOne Makers issues the CNAME target for a
 * custom domain but exposes NO API to create the matching DNS record (its
 * Open API only returns `CustomDomains[].Domain/.Status` — no target field),
 * so the record has to be written by hand. This module removes that manual
 * step: given the target EdgeOne shows in its console popup, it upserts the
 * CNAME (and the optional ownership TXT) in Cloudflare.
 *
 * CREDENTIALS
 * -----------
 * A Cloudflare API Token scoped to the target zone with `Zone:DNS:Edit`.
 * Stored per project (matching how `edgeone_token` / `makers_key` are stored)
 * and never sent to the browser — every call is proxied by the backend.
 *
 * PROXY MUST STAY OFF
 * -------------------
 * The record is created as "DNS only" (proxied=false). EdgeOne validates that
 * it can see a real CNAME; an orange-cloud record resolves to Cloudflare IPs
 * instead, so ownership verification never completes.
 *
 * API reference: https://developers.cloudflare.com/api/
 */

import dns from 'dns/promises';

const CF_TIMEOUT_MS = 15000;

/**
 * API base, read LAZILY (matching config.js): the EdgeOne Makers Cloud Functions
 * entry sets env in its module body, so a module-scope read could capture a
 * stale value. Overridable so tests can point at a local stub.
 */
function cfApiBase() {
  return (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
}

/* ------------------------------ helpers ------------------------------ */

/** Strip scheme/path/port/trailing dot and lowercase — a bare DNS name. */
export function normalizeDomain(input) {
  return String(input ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/** A usable DNS name (allows the leading `*.` wildcard label). */
const DOMAIN_RE = /^(\*\.)?([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,}$/;

export function isValidDomain(name) {
  return DOMAIN_RE.test(normalizeDomain(name));
}

/** True when `hostname` sits inside `zone` (equal, or a subdomain of it). */
export function isInZone(hostname, zone) {
  const h = normalizeDomain(hostname).replace(/^\*\./, '');
  const z = normalizeDomain(zone);
  return h === z || h.endsWith(`.${z}`);
}

/** Redact a secret for logs / API responses. */
export function maskSecret(value) {
  return value ? '***' : '';
}

/* ---------------------------- HTTP plumbing ---------------------------- */

/**
 * One Cloudflare API call.
 * @returns {Promise<{result:any, resultInfo?:object}>}
 * @throws {Error} with Cloudflare's own error codes/messages (they are precise
 *   enough to act on, e.g. 6003 "Invalid request headers" for a bad token).
 */
async function cfRequest(token, path, { method = 'GET', body } = {}) {
  if (!token) throw new Error('缺少 Cloudflare API Token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CF_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfApiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(
      err.name === 'AbortError'
        ? `Cloudflare API 超时（${CF_TIMEOUT_MS / 1000}s）：${path}`
        : `Cloudflare API 请求失败：${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Cloudflare API 返回非 JSON（HTTP ${res.status}）`);
  if (!data.success) {
    const errors = (data.errors || []).map(e => `${e.code} ${e.message}`.trim()).join('; ');
    throw new Error(`Cloudflare API 错误（HTTP ${res.status}）：${errors || '未知错误'}`);
  }
  return data;
}

/* ------------------------------- token ------------------------------- */

/** Validate the token and report which scopes/zone the caller may act on. */
export async function verifyToken(token) {
  const data = await cfRequest(token, '/user/tokens/verify');
  return {
    status: data.result?.status || 'unknown',
    id: data.result?.id || '',
    expiresOn: data.result?.expires_on || null
  };
}

/* -------------------------------- zones -------------------------------- */

/** Cap on zone pagination — a token should not see thousands of zones. */
const MAX_ZONE_PAGES = 5;
const ZONE_PAGE_SIZE = 50;

/** All zones the token can read. */
export async function listZones(token) {
  const zones = [];
  for (let page = 1; page <= MAX_ZONE_PAGES; page++) {
    const data = await cfRequest(token, `/zones?per_page=${ZONE_PAGE_SIZE}&page=${page}`);
    const batch = data.result || [];
    zones.push(...batch.map(z => ({ id: z.id, name: z.name, status: z.status })));
    const info = data.result_info || {};
    if (batch.length < ZONE_PAGE_SIZE || page >= (info.total_pages || 1)) break;
  }
  return zones;
}

/**
 * Resolve the zone that owns `hostname`.
 * Longest suffix wins, so a token holding both `example.com` and `sub.example.com`
 * updates the more specific (authoritative) one.
 */
export async function findZoneForHostname(token, hostname) {
  const host = normalizeDomain(hostname).replace(/^\*\./, '');
  if (!host) throw new Error('自定义域名不能为空');
  const zones = await listZones(token);
  const matches = zones.filter(z => isInZone(host, z.name)).sort((a, b) => b.name.length - a.name.length);
  if (matches.length === 0) {
    throw new Error(
      `Cloudflare 中找不到 ${host} 所属的 Zone。` +
      `请确认 Token 具备该 Zone 的 Zone:DNS:Edit 权限（当前可见 ${zones.length} 个 Zone${zones.length ? '：' + zones.slice(0, 5).map(z => z.name).join(', ') : ''}）`
    );
  }
  return matches[0];
}

/* ----------------------------- DNS records ----------------------------- */

const TTL_AUTO = 1; // Cloudflare's "Auto"

/** List DNS records, optionally filtered by type/name. */
export async function listDnsRecords(token, zoneId, { type, name } = {}) {
  const params = new URLSearchParams({ per_page: '100' });
  if (type) params.set('type', type);
  if (name) params.set('name', normalizeDomain(name));
  const data = await cfRequest(token, `/zones/${zoneId}/dns_records?${params.toString()}`);
  return (data.result || []).map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: r.ttl
  }));
}

/** Find a single record by exact name+type (Cloudflare guarantees uniqueness). */
export async function findDnsRecord(token, zoneId, { type, name }) {
  const records = await listDnsRecords(token, zoneId, { type, name });
  const target = normalizeDomain(name);
  return records.find(r => r.name === target && r.type === type) || null;
}

/**
 * Create or update a DNS record so it matches the desired content/proxy state.
 * Idempotent: a record already in the desired state is left untouched.
 *
 * @returns {Promise<{action:'created'|'updated'|'unchanged', record:object}>}
 */
export async function upsertDnsRecord(token, zoneId, { type, name, content, proxied = false, ttl = TTL_AUTO }) {
  const recordName = normalizeDomain(name);
  const desiredContent = type === 'CNAME' ? normalizeDomain(content) : String(content ?? '').trim();
  if (!desiredContent) throw new Error(`${type} 记录的值不能为空`);

  const existing = await findDnsRecord(token, zoneId, { type, name: recordName });

  // Cloudflare returns CNAME content without the trailing dot; compare normalized.
  const contentMatches = existing &&
    (type === 'CNAME'
      ? normalizeDomain(existing.content) === desiredContent
      : String(existing.content).trim() === desiredContent);

  if (existing && contentMatches && !!existing.proxied === !!proxied) {
    return { action: 'unchanged', record: existing };
  }

  if (existing) {
    const data = await cfRequest(token, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: 'PATCH',
      body: { type, name: recordName, content: desiredContent, ttl, proxied: !!proxied }
    });
    const r = data.result;
    return { action: 'updated', record: { id: r.id, type: r.type, name: r.name, content: r.content, proxied: !!r.proxied, ttl: r.ttl } };
  }

  const data = await cfRequest(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: { type, name: recordName, content: desiredContent, ttl, proxied: !!proxied }
  });
  const r = data.result;
  return { action: 'created', record: { id: r.id, type: r.type, name: r.name, content: r.content, proxied: !!r.proxied, ttl: r.ttl } };
}

export async function deleteDnsRecord(token, zoneId, recordId) {
  await cfRequest(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  return true;
}

/* ----------------------------- orchestration ----------------------------- */

/**
 * Bind one custom domain: ensure the optional ownership TXT and the CNAME exist.
 *
 * `cnameTarget` is the value EdgeOne Makers shows in its console popup, e.g.
 * `a4285573.cis2.20140107.xyz.dns.edgeone.site.` — the leading hash is minted
 * server-side when the domain is added, which is exactly why it cannot be
 * derived and must be supplied.
 *
 * @param {object} opts
 * @param {string} opts.token Cloudflare API token
 * @param {string} opts.hostname custom domain, e.g. cis2.20140107.xyz
 * @param {string} opts.cnameTarget EdgeOne-provided CNAME target
 * @param {string} [opts.txtName] ownership TXT record name
 * @param {string} [opts.txtValue] ownership TXT record value
 * @returns {Promise<{zone:object, steps:Array<{step:string, action:string, detail:string}>}>}
 */
export async function bindDomain({ token, hostname, cnameTarget, txtName, txtValue }) {
  const host = normalizeDomain(hostname);
  if (!isValidDomain(host)) throw new Error(`自定义域名格式无效：${hostname || '(空)'}`);

  const target = normalizeDomain(cnameTarget);
  if (!isValidDomain(target)) throw new Error(`EdgeOne CNAME 目标格式无效：${cnameTarget || '(空)'}`);

  // A CNAME must never point at itself — that is an unresolvable loop.
  if (target === host) throw new Error('CNAME 目标不能与自定义域名相同（会形成解析回路）');

  const steps = [];
  const zone = await findZoneForHostname(token, host);

  // 1. Optional ownership TXT (only some EdgeOne verification flows need it).
  const txt = normalizeDomain(txtName);
  if (txt && txtValue) {
    const r = await upsertDnsRecord(token, zone.id, { type: 'TXT', name: txt, content: txtValue, proxied: false });
    steps.push({ step: 'TXT', action: r.action, detail: `${r.record.name} = ${r.record.content}` });
  }

  // 2. The CNAME the domain actually resolves through (DNS only, never proxied).
  const cname = await upsertDnsRecord(token, zone.id, { type: 'CNAME', name: host, content: target, proxied: false });
  steps.push({
    step: 'CNAME',
    action: cname.action,
    detail: `${cname.record.name} → ${cname.record.content}${cname.record.proxied ? '（警告：代理已开启，EdgeOne 无法校验归属）' : ''}`
  });

  return { zone, steps };
}

/**
 * Read-only DNS health check for a custom domain: is the record present, is it
 * pointed at the expected target, is proxying off, and has it propagated?
 *
 * Propagation is best-effort — a serverless runtime may have no outbound DNS,
 * so a failed lookup degrades to `checked:false` instead of throwing.
 */
export async function checkDomainDns({ token, hostname, cnameTarget }) {
  const host = normalizeDomain(hostname);
  if (!isValidDomain(host)) throw new Error(`自定义域名格式无效：${hostname || '(空)'}`);

  const zone = await findZoneForHostname(token, host);
  const record = await findDnsRecord(token, zone.id, { type: 'CNAME', name: host });
  const expected = cnameTarget ? normalizeDomain(cnameTarget) : '';
  const actual = record ? normalizeDomain(record.content) : '';

  let propagation = { checked: false, resolved: [], reason: '' };
  try {
    const resolved = await dns.resolveCname(host);
    const list = (resolved || []).map(normalizeDomain);
    propagation = { checked: true, resolved: list, reason: '' };
  } catch (err) {
    const transient = ['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN'];
    propagation = {
      checked: false,
      resolved: [],
      reason: transient.includes(err.code) ? `未解析到 CNAME（${err.code}）` : `DNS 查询不可用：${err.code || err.message}`
    };
  }

  const propagationMatches = propagation.checked && expected
    ? propagation.resolved.some(r => r === expected)
    : null;

  return {
    zone: { id: zone.id, name: zone.name },
    record: record
      ? { id: record.id, name: record.name, type: record.type, content: record.content, proxied: record.proxied }
      : null,
    expectedTarget: expected,
    contentMatches: !!record && expected ? actual === expected : null,
    proxiedWarning: !!record && record.proxied,
    propagation,
    propagationMatches
  };
}

/**
 * Custom-domain binding orchestration: EdgeOne Makers + Cloudflare.
 *
 * THE TWO HALVES — AND WHY ONLY ONE IS AUTOMATED
 * ----------------------------------------------
 * Serving a prototype on e.g. `cis2.20140107.xyz` needs two independent things:
 *
 *   1. EdgeOne Makers must KNOW the domain, and hands back a per-domain CNAME
 *      target (`<hash>.<domain>.dns.edgeone.site`). This exists ONLY in the
 *      Makers console: the Open API has no domain action at all (verified by
 *      enumerating every Action the CLI knows and by differential probing —
 *      auth is validated before Action names, so no action can be discovered
 *      without a live token; `edgeone@1.6.40` exposes none), and
 *      DescribePagesProjects returns just `CustomDomains[].Domain/.Status`
 *      with no target field.
 *   2. DNS must point the domain at that target. This lives in Cloudflare and
 *      IS fully automatable — which is what this module does.
 *
 * So the flow is "one console click, everything else automatic":
 *   console: 添加自定义域名 → copy the CNAME target
 *   here:    paste it → CNAME upserted → propagation checked → EdgeOne status read back
 *
 * The CNAME target is never guessable: the hash prefix is minted server-side
 * per domain, so it must be supplied. Everything after that is automatic.
 */

import { bindDomain, checkDomainDns, verifyToken, normalizeDomain } from './cloudflare.js';
import { findProjectByName, describeProjectDomains } from './makersApi.js';
import { update } from '../db.js';

/** What the operator still has to do by hand — surfaced verbatim in the UI. */
export const MANUAL_EDGEONE_STEPS = [
  '登录 EdgeOne Makers 控制台，进入该项目 → 域名管理 → 添加自定义域名。',
  '在弹窗填入自定义域名（根域名或子域名；Makers 不支持泛域名，且泛解析无法让多个项目共用一条记录）。',
  '复制弹窗给出的 CNAME 目标（形如 a4285573.cis2.20140107.xyz.dns.edgeone.site.），粘贴到下方输入框。',
  '若弹窗还要求添加归属验证 TXT 记录，一并填入（可选）。',
  '保存后点击「绑定 DNS」——Cloudflare 记录、解析校验、EdgeOne 生效状态都会自动完成。'
];

/** Normalised binding config extracted from a project record. */
export function domainConfigOf(project) {
  return {
    custom_domain: normalizeDomain(project.custom_domain),
    cname_target: normalizeDomain(project.cname_target),
    cloudflare_token: project.cloudflare_token || '',
    txt_name: normalizeDomain(project.domain_txt_name),
    txt_value: String(project.domain_txt_value || '').trim()
  };
}

/** Which inputs are still missing before binding can run. */
export function missingDomainInputs(project) {
  const cfg = domainConfigOf(project);
  const missing = [];
  if (!cfg.custom_domain) missing.push('自定义域名');
  if (!cfg.cname_target) missing.push('EdgeOne CNAME 目标');
  if (!cfg.cloudflare_token) missing.push('Cloudflare API Token');
  return { cfg, missing };
}

/**
 * Read EdgeOne's view of this project's domains. Read-only: uses
 * findProjectByName (never creates), and degrades to `available:false` when no
 * EdgeOne token is configured or the project does not exist yet.
 */
export async function describeEdgeoneState(project) {
  if (!project.edgeone_token) {
    return { available: false, reason: '未配置 EdgeOne API Token' };
  }
  const name = project.edgeone_project_name || `proto-${project.slug || project.id}`;
  try {
    const proj = await findProjectByName(project.edgeone_token, name);
    if (!proj) return { available: false, reason: `EdgeOne 上尚无项目 ${name}（尚未部署过）` };
    const info = await describeProjectDomains(project.edgeone_token, proj.ProjectId);
    const host = normalizeDomain(project.custom_domain);
    const match = (info.customDomains || []).find(d => normalizeDomain(d.Domain) === host);
    return {
      available: true,
      projectId: proj.ProjectId,
      presetDomain: info.presetDomain,
      accelerationArea: info.accelerationArea,
      filingRequired: info.filingRequired,
      domains: info.customDomains || [],
      boundInEdgeone: !!match,
      domainStatus: match ? match.Status : '(未在 EdgeOne 添加)'
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** Validate a Cloudflare token (owner-facing "test connection" action). */
export async function testCloudflareToken(token) {
  const info = await verifyToken(token);
  return info;
}

/**
 * Bind the project's custom domain: upsert DNS in Cloudflare, then verify.
 *
 * @param {object} project project record
 * @param {object} [opts]
 * @param {boolean} [opts.skipVerify] skip the post-write verification pass
 * @returns {Promise<{ok:boolean, reason?:string, missing?:string[], cfg?:object,
 *   zone?:object, steps?:Array, dns?:object, edgeone?:object, manualSteps:string[]}>}
 */
export async function bindProjectDomain(project, { skipVerify = false } = {}) {
  const { cfg, missing } = missingDomainInputs(project);
  if (missing.length) {
    return { ok: false, reason: 'NOT_CONFIGURED', missing, manualSteps: MANUAL_EDGEONE_STEPS };
  }

  const bound = await bindDomain({
    token: cfg.cloudflare_token,
    hostname: cfg.custom_domain,
    cnameTarget: cfg.cname_target,
    txtName: cfg.txt_name,
    txtValue: cfg.txt_value
  });

  const result = {
    ok: true,
    cfg: {
      custom_domain: cfg.custom_domain,
      cname_target: cfg.cname_target,
      has_cloudflare_token: true,
      txt_name: cfg.txt_name
    },
    zone: bound.zone,
    steps: bound.steps,
    manualSteps: MANUAL_EDGEONE_STEPS
  };

  // Verification never fails the binding — the record is already written, and a
  // missing answer here is informational (propagation lag, no outbound DNS).
  if (!skipVerify) {
    try {
      result.dns = await checkDomainDns({
        token: cfg.cloudflare_token,
        hostname: cfg.custom_domain,
        cnameTarget: cfg.cname_target
      });
    } catch (err) {
      result.dns = { error: err.message };
    }
  }
  result.edgeone = await describeEdgeoneState(project);
  return result;
}

/** Read-only DNS + EdgeOne status check for a project's custom domain. */
export async function checkProjectDomain(project) {
  const { cfg, missing } = missingDomainInputs(project);
  if (missing.length) {
    return { ok: false, reason: 'NOT_CONFIGURED', missing, manualSteps: MANUAL_EDGEONE_STEPS };
  }
  const result = {
    ok: true,
    cfg: { custom_domain: cfg.custom_domain, cname_target: cfg.cname_target },
    manualSteps: MANUAL_EDGEONE_STEPS
  };
  try {
    result.dns = await checkDomainDns({
      token: cfg.cloudflare_token,
      hostname: cfg.custom_domain,
      cnameTarget: cfg.cname_target
    });
  } catch (err) {
    result.dns = { error: err.message };
  }
  result.edgeone = await describeEdgeoneState(project);
  return result;
}

/**
 * Keep a project's custom-domain CNAME in sync — but skip the work when it
 * cannot be stale.
 *
 * The record is a pure function of (custom_domain, cname_target) and a redeploy
 * changes neither, so a recorded successful sync for the same pair skips 2–3
 * Cloudflare API round-trips on every subsequent deploy while still healing a
 * stale record the instant the target changes (e.g. after re-adding the domain
 * in the EdgeOne console, which mints a new hash).
 *
 * Never throws — a DNS problem must not fail an otherwise successful deploy.
 *
 * @returns {Promise<null|{skipped?:string, ok?:boolean, domain?:string, zone?:string, steps?:Array, error?:string}>}
 *   null when the project has no domain binding configured at all.
 */
export async function syncDomainDnsIfStale(project) {
  const cfg = domainConfigOf(project);
  if (!cfg.custom_domain || !cfg.cname_target || !cfg.cloudflare_token) return null;

  const synced = project.domain_dns_synced;
  if (synced && synced.domain === cfg.custom_domain && synced.target === cfg.cname_target) {
    return { skipped: 'unchanged', domain: cfg.custom_domain };
  }

  try {
    const bound = await bindProjectDomain(project, { skipVerify: true });
    if (!bound.ok) return { ok: false, error: `配置不完整：${bound.missing.join('、')}` };

    // Record only on success: a failure must be retried on the next deploy.
    await update('projects', project.id, {
      domain_dns_synced: {
        domain: cfg.custom_domain,
        target: cfg.cname_target,
        at: new Date().toISOString(),
        zone: bound.zone.name
      }
    });
    console.log(`[domain] DNS synced: ${cfg.custom_domain} → ${cfg.cname_target} (zone ${bound.zone.name})`);
    return { ok: true, domain: cfg.custom_domain, zone: bound.zone.name, steps: bound.steps };
  } catch (err) {
    console.warn(`[domain] DNS sync failed for ${cfg.custom_domain}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

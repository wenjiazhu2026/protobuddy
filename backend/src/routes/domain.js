import { Router } from 'express';
import { getById } from '../db.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';
import {
  bindProjectDomain,
  checkProjectDomain,
  testCloudflareToken,
  domainConfigOf,
  MANUAL_EDGEONE_STEPS
} from '../services/domainBinding.js';

const router = Router();

/**
 * Custom-domain DNS automation (Cloudflare side).
 *
 * EdgeOne Makers exposes no API for adding a custom domain, so the console step
 * cannot be removed. Everything downstream of it can be: once the owner pastes
 * the CNAME target EdgeOne shows, these endpoints write the Cloudflare record,
 * check propagation and read EdgeOne's activation status back.
 *
 * The Cloudflare token lives on the project record and is never returned to the
 * browser — only a "configured?" flag is.
 */

/** Local config summary — deliberately makes no external API calls. */
router.get('/:id/domain', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const cfg = domainConfigOf(project);
  res.json({
    custom_domain: cfg.custom_domain,
    cname_target: cfg.cname_target,
    txt_name: cfg.txt_name,
    has_txt_value: !!cfg.txt_value,
    has_cloudflare_token: !!cfg.cloudflare_token,
    ready: !!(cfg.custom_domain && cfg.cname_target && cfg.cloudflare_token),
    manual_steps: MANUAL_EDGEONE_STEPS
  });
});

/** Verify the stored Cloudflare token is active and usable. */
router.post('/:id/domain/test', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Prefer a token supplied in the request (lets the owner test before saving).
  const token = String(req.body?.cloudflare_token || '').trim() || project.cloudflare_token;
  if (!token) {
    return res.status(400).json({ error: '未配置 Cloudflare API Token', missing: ['Cloudflare API Token'] });
  }
  try {
    const info = await testCloudflareToken(token);
    res.json({ ok: true, token: info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** Create/update the Cloudflare DNS records for this project's custom domain. */
router.post('/:id/domain/bind', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Allow one-shot overrides so the owner can bind without a separate save.
  const override = {
    custom_domain: req.body?.custom_domain !== undefined ? req.body.custom_domain : project.custom_domain,
    cname_target: req.body?.cname_target !== undefined ? req.body.cname_target : project.cname_target,
    cloudflare_token: String(req.body?.cloudflare_token || '').trim() || project.cloudflare_token,
    domain_txt_name: req.body?.domain_txt_name !== undefined ? req.body.domain_txt_name : project.domain_txt_name,
    domain_txt_value: req.body?.domain_txt_value !== undefined ? req.body.domain_txt_value : project.domain_txt_value
  };

  try {
    const result = await bindProjectDomain({ ...project, ...override });
    if (!result.ok) {
      return res.status(400).json({
        error: `绑定所需配置不完整：${result.missing.join('、')}`,
        missing: result.missing,
        manual_steps: MANUAL_EDGEONE_STEPS
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[domain] bind failed:', err);
    res.status(502).json({ error: err.message, manual_steps: MANUAL_EDGEONE_STEPS });
  }
});

/** Read-only: where does DNS point, and does EdgeOne consider the domain live? */
router.post('/:id/domain/verify', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const result = await checkProjectDomain(project);
    if (!result.ok) {
      return res.status(400).json({
        error: `校验所需配置不完整：${result.missing.join('、')}`,
        missing: result.missing,
        manual_steps: MANUAL_EDGEONE_STEPS
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[domain] verify failed:', err);
    res.status(502).json({ error: err.message, manual_steps: MANUAL_EDGEONE_STEPS });
  }
});

export default router;

import { Router } from 'express';
import { getById, insert, update, query } from '../db.js';
import { deployToEdgeOne } from '../services/edgeone.js';
import { prepareForDeploy, probeGeneratorEnv, apiBaseFromReq } from '../services/generator.js';
import { checkDeployment, getProjectUrl, describeProjectDomains, getOrCreateProject } from '../services/makersApi.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// Deploy a project — owner operation
router.post('/:id/deploy', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    // 方案 A：部署前检查 Python 生成器。项目含生成器脚本时，必须先重新生成
    // HTML 再部署，否则部署的是旧产物。
    // - local 模式：自动执行生成器（改脚本 → 重新生成 → 部署新产物 闭环）
    // - blob 模式：线上函数无法执行 Python → 返回 regenerateRequired，
    //   由外部执行环境 CLI（scripts/regenerate.js）完成生成后再部署
    // - ?force=1：跳过生成器检查（用户确认产物已是最新，如纯上传新 HTML）
    const gen = await prepareForDeploy(req.params.id, { force: req.query.force === '1' });
    if (gen.generator && gen.needsExternal) {
      return res.json({
        success: false,
        regenerateRequired: true,
        generator: { script: gen.generator.script },
        message: gen.message,
        error: gen.message,
        hint: `node scripts/regenerate.js --project ${req.params.id} --api ${apiBaseFromReq(req)}`
      });
    }
    if (gen.generator && gen.ran && !gen.ok) {
      return res.status(409).json({
        success: false,
        error: gen.error,
        generator: { script: gen.generator.script },
        message: `生成器执行失败：${gen.error}`,
        stdout: gen.stdout,
        stderr: gen.stderr
      });
    }

    const result = await deployToEdgeOne(project);

    const version = (project.version || 0) + 1;
    let previewUrl = result.url;
    let method = result.method;
    let fallbackUrl = '';

    // If EdgeOne failed but CLI may have succeeded, keep local fallback available
    if (result.method === 'edgeone_failed') {
      fallbackUrl = `/api/projects/${req.params.id}/preview/`;
      previewUrl = fallbackUrl;
      method = 'local_fallback';
    }

    // If local hosting, cloud_preview or no URL returned, construct URL from request
    // (in Makers Cloud Functions mode the preview is served by this same function).
    // Use a RELATIVE path so the browser always resolves it against the current origin.
    // Serverless runtimes often report internal/loopback hostnames in req.get('host'),
    // which produced broken preview URLs like CloudStudio domains.
    if (result.method === 'local' || result.method === 'cloud_preview' || (!previewUrl && method !== 'edgeone_deploying')) {
      previewUrl = `/api/projects/${req.params.id}/preview/${version ? `?v=${version}` : ''}`;
      result.url = previewUrl;
    }

    // Record deployment
    const deployment = await insert('deployments', {
      project_id: req.params.id,
      version,
      url: previewUrl,
      env: 'production',
      status: method === 'edgeone_deploying' ? 'deploying'
        : result.success || method === 'local_fallback' ? 'success' : 'failed',
      method,
      log: result.log || result.error || '',
      makers_project_id: result.projectId || '',
      makers_deployment_id: result.deploymentId || ''
    });

    // Update project
    await update('projects', req.params.id, {
      current_url: method === 'edgeone_deploying' ? (project.current_url || '') : previewUrl,
      deploy_method: method,
      status: method === 'edgeone_deploying' ? 'deploying'
        : result.success || method === 'local_fallback' ? 'deployed' : 'deploy_failed',
      version
    });

    res.json({
      success: result.success || method === 'local_fallback',
      url: previewUrl,
      method,
      status: method === 'edgeone_deploying' ? 'deploying' : undefined,
      edgeone_url: result.method === 'edgeone' ? result.url : '',
      fallback_url: fallbackUrl,
      version,
      deployment_id: deployment.id,
      error: result.error,
      log_file: result.logFile,
      deploy_stats: result.deployStats || null,
      custom_domain_bound: result.customDomainBound,
      custom_domain_status: result.customDomainStatus,
      generator: gen.generator ? {
        script: gen.generator.script,
        ran: !!gen.ran,
        forced: !!gen.forced,
        changedFiles: (gen.changedFiles || []).map(c => `${c.action} ${c.path}`)
      } : null
    });
  } catch (err) {
    console.error('[deploy] Error:', err);
    res.status(500).json({ error: `Deployment failed: ${err.message}` });
  }
});

// Poll the status of an in-flight EdgeOne deployment (frontend keeps asking
// until it leaves Process/Pending, then the URL is resolved and persisted).
router.get('/:id/deploy-status', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const depId = req.query.dep;
  const deployment = depId
    ? (await getById('deployments', depId))
    : (await query('deployments', d => String(d.project_id) === String(req.params.id))).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

  if (deployment.status !== 'deploying') {
    return res.json({ status: deployment.status, url: deployment.url, method: deployment.method, deployment_id: deployment.id });
  }

  const token = project.edgeone_token;
  const makersProjectId = deployment.makers_project_id;
  const makersDeploymentId = deployment.makers_deployment_id;
  if (!token || !makersProjectId || !makersDeploymentId) {
    return res.json({ status: deployment.status, url: deployment.url, method: deployment.method, deployment_id: deployment.id });
  }

  try {
    const check = await checkDeployment({ token, projectId: makersProjectId, deploymentId: makersDeploymentId });
    if (!check.done) {
      return res.json({ status: 'deploying', method: deployment.method, deployment_id: deployment.id });
    }
    if (check.status !== 'Success') {
      await update('deployments', deployment.id, { status: 'failed', log: `EdgeOne deployment ended with status: ${check.status}` });
      await update('projects', req.params.id, { status: 'deploy_failed' });
      return res.json({ status: 'failed', error: `EdgeOne 部署状态: ${check.status}`, method: deployment.method, deployment_id: deployment.id });
    }
    const urlResult = await getProjectUrl(token, makersProjectId, {
      preferredDomain: project.custom_domain || undefined
    });
    const url = urlResult.url;
    await update('deployments', deployment.id, { status: 'success', url, log: `EdgeOne deploy success: ${url}` });
    await update('projects', req.params.id, { current_url: url, deploy_method: 'edgeone', status: 'deployed' });
    return res.json({
      status: 'success', url, method: 'edgeone', deployment_id: deployment.id,
      customDomainBound: urlResult.customDomainBound,
      customDomainStatus: urlResult.customDomainStatus
    });
  } catch (err) {
    return res.json({ status: 'deploying', method: deployment.method, deployment_id: deployment.id, error: err.message });
  }
});

// Manually set/update project preview URL — owner operation
router.post('/:id/preview-url', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { url } = req.body || {};
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  await update('projects', req.params.id, {
    current_url: url,
    deploy_method: 'edgeone_manual',
    status: 'deployed'
  });

  const deployment = await insert('deployments', {
    project_id: req.params.id,
    version: project.version || 1,
    url,
    env: 'production',
    status: 'success',
    method: 'edgeone_manual',
    log: 'Manually set EdgeOne preview URL.'
  });

  res.json({ success: true, url, deployment_id: deployment.id });
});

// Diagnostic: list all custom domains bound to the project in EdgeOne — owner
// operation (exposes project ID and domain configuration from the EdgeOne API)
router.get('/:id/domains', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.edgeone_token) return res.json({ error: 'No EdgeOne token configured' });

  try {
    // Resolve the Makers project ID by name
    const { projectId } = await getOrCreateProject(project.edgeone_token, project.edgeone_project_name || `proto-${project.slug || project.id}`);
    const info = await describeProjectDomains(project.edgeone_token, projectId);
    res.json({
      configured_custom_domain: project.custom_domain || '',
      edgeone_project_name: project.edgeone_project_name || '',
      edgeone_project_id: projectId,
      ...info
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List deployments for a project
router.get('/:id/deployments', async (req, res) => {
  const deployments = await query('deployments', d => String(d.project_id) === String(req.params.id));
  deployments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(deployments);
});

// Get deployment status
router.get('/:id/deployments/:depId', async (req, res) => {
  const dep = await getById('deployments', req.params.depId);
  if (!dep || String(dep.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  res.json(dep);
});

export default router;

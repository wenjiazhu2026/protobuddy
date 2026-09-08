import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken, buildRegenerateCmd } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';
import { useToast } from '../components/ToastContext.jsx';

export default function Dashboard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);

  const [manualUrl, setManualUrl] = useState('');
  const [showManualUrl, setShowManualUrl] = useState(false);
  const [lastDeploy, setLastDeploy] = useState(null);
  const [regenerateInfo, setRegenerateInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, f, deps] = await Promise.all([
        api.getProject(id),
        api.listFiles(id),
        api.listDeployments(id).catch(() => [])
      ]);
      setProject(p);
      setFiles(f);
      setDeployments(deps);
      setLastDeploy(deps[0] || null);
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleUploadZip = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      // Owner operation: guarded by the owner password (one-time per session)
      const result = await guard(id, () => api.uploadPrototypeChunked(id, 'zip', file, getOwnerToken(id)));
      showToast(`ZIP 上传成功，共 ${result.fileCount} 个文件`);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('上传失败: ' + err.message, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleUploadFolder = async (e) => {
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;
    setUploading(true);
    try {
      const items = fileList.map(file => ({
        file,
        relPath: file.webkitRelativePath || file.name
      }));
      const result = await guard(id, () => api.uploadPrototypeChunked(id, 'folder', items, getOwnerToken(id)));
      showToast(`文件夹上传成功，共 ${result.fileCount} 个文件`);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('文件夹上传失败: ' + err.message, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleUploadHtml = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await guard(id, () => api.uploadPrototypeChunked(id, 'html', file, getOwnerToken(id)));
      showToast('index.html 上传成功');
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('上传失败: ' + err.message, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeploy = async () => {
    setDeploying(true);
    try {
      // Owner operation: guarded by the owner password (one-time per session)
      let result = await guard(id, () => api.deploy(id, getOwnerToken(id)));
      // EdgeOne Pages API deploy may still be building server-side; keep polling
      // until the deployment leaves Process/Pending (max ~5 min).
      if (result.method === 'edgeone_deploying' || result.status === 'deploying') {
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 5000));
          const st = await api.deployStatus(id, result.deployment_id);
          if (st.status === 'success') { result = { ...result, success: true, url: st.url, method: 'edgeone', custom_domain_bound: st.customDomainBound, custom_domain_status: st.customDomainStatus }; break; }
          if (st.status === 'failed') { result = { ...result, success: false, error: st.error || 'EdgeOne 部署失败' }; break; }
        }
        if (result.method === 'edgeone_deploying' && result.url === '') {
          // still unknown after budget - treat as pending success info
          result = { ...result, success: false, error: 'EdgeOne 构建超时，请稍后在部署历史中查看结果' };
        }
      }
      setLastDeploy({
        id: result.deployment_id,
        version: result.version,
        url: result.url,
        method: result.method,
        status: result.success ? 'success' : 'failed',
        log_file: result.log_file,
        error: result.error,
        created_at: new Date().toISOString()
      });
      if (result.regenerateRequired) {
        // 方案 A：项目含 Python 生成器脚本，线上环境无法执行 → 提示使用外部
        // 执行环境 CLI 重新生成后再部署（避免部署旧 HTML）。
        setRegenerateInfo(result);
        showToast('检测到 Python 生成器：需先重新生成 HTML 再部署', 'error');
      } else if (result.success) {
        let msg = `部署成功 (${result.method === 'edgeone' ? 'EdgeOne' : result.method === 'edgeone_manual' ? 'EdgeOne（手动）' : result.method === 'cloud_preview' ? 'EdgeOne 全栈' : '本地托管'} v${result.version})`;
        if (result.custom_domain_status === 'not_bound') {
          msg += ' · 自定义域名尚未绑定，请前往 EdgeOne 控制台绑定';
        } else if (result.custom_domain_status && result.custom_domain_status !== 'Pass' && !result.custom_domain_bound) {
          msg += ` · 自定义域名验证中 (${result.custom_domain_status})`;
        }
        showToast(msg);
      } else {
        showToast('部署失败: ' + (result.error || '未知错误'), 'error');
      }
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('部署失败: ' + err.message, 'error');
    } finally {
      setDeploying(false);
    }
  };

  const handleForceDeploy = async () => {
    if (!confirm('确定跳过生成器检查，直接部署当前存储中的产物？如果生成器脚本已被修改但未重新生成，部署的将是旧版本 HTML。')) return;
    setDeploying(true);
    try {
      const result = await guard(id, () => api.deploy(id, getOwnerToken(id), true));
      setRegenerateInfo(null);
      if (result.success) {
        showToast(`已强制部署 (v${result.version})`);
      } else {
        showToast('部署失败: ' + (result.error || '未知错误'), 'error');
      }
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('部署失败: ' + err.message, 'error');
    } finally {
      setDeploying(false);
    }
  };

  const handleSetManualUrl = async () => {
    if (!manualUrl.trim() || !manualUrl.startsWith('http')) {
      showToast('请输入有效的 http(s) 链接', 'error');
      return;
    }
    try {
      // Owner operation: guarded by the owner password (one-time per session)
      await guard(id, () => api.setPreviewUrl(id, manualUrl.trim(), getOwnerToken(id)));
      showToast('在线预览地址已更新');
      setShowManualUrl(false);
      setManualUrl('');
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('更新失败: ' + err.message, 'error');
    }
  };

  const handleSelectFile = async (file) => {
    setSelectedFile(file);
    setEditing(false);
    try {
      const content = await api.readFile(id, file.path);
      setFileContent(content.binary ? '[二进制文件，无法预览]' : content.data);
    } catch {
      setFileContent('[无法读取文件内容]');
    }
  };

  const handleSaveFile = async () => {
    try {
      // Owner operation: modifying prototype files is owner maintenance
      await guard(id, () => api.writeFile(id, selectedFile.path, fileContent, getOwnerToken(id)));
      showToast('文件已保存');
      setEditing(false);
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('保存失败: ' + err.message, 'error');
    }
  };

  const fileIcon = (path) => {
    const ext = path.split('.').pop().toLowerCase();
    const icons = {
      html: '🌐', css: '🎨', js: '📜', json: '📋',
      png: '🖼', jpg: '🖼', jpeg: '🖼', svg: '🖼',
    };
    return icons[ext] || '📄';
  };

  const isTextFile = (path) => {
    const ext = path.split('.').pop().toLowerCase();
    return ['html', 'css', 'js', 'json', 'txt', 'md', 'xml', 'svg'].includes(ext);
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  return (
    <div className="main-content" style={{ paddingTop: 16 }}>
      {/* Breadcrumb + actions */}
      <div className="page-header">
        <div>
          <Link to="/" className="back-link">← 返回项目列表</Link>
          <h1 className="page-title">{project.name}</h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <span className={`badge ${project.status === 'deployed' ? 'badge-green' : project.status === 'deploying' ? 'badge-blue' : project.status === 'deploy_failed' ? 'badge-red' : 'badge-gray'}`}>
              {project.status === 'deployed' ? '已部署' : project.status === 'deploying' ? '部署中' : project.status === 'deploy_failed' ? '部署失败' : project.status === 'uploaded' ? '已上传' : '已创建'}
            </span>
            {project.version > 0 && <span className="badge badge-blue">v{project.version}</span>}
            {project.deploy_method && (
              <span className="badge badge-gray">
                {project.deploy_method === 'edgeone' ? 'EdgeOne' : project.deploy_method === 'edgeone_deploying' ? 'EdgeOne 构建中' : project.deploy_method === 'edgeone_manual' ? 'EdgeOne（手动）' : project.deploy_method === 'cloud_preview' ? 'EdgeOne 全栈' : project.deploy_method === 'local_fallback' ? '本地兜底' : '本地托管'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Deploy status card */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span className="card-title">部署状态</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>上传原型:</span>
            <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
              {uploading ? '上传中...' : 'ZIP 包'}
              <input type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={handleUploadZip} disabled={uploading} />
            </label>
            <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
              文件夹
              <input type="file" webkitdirectory="true" multiple style={{ display: 'none' }} onChange={handleUploadFolder} disabled={uploading} />
            </label>
            <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
              index.html
              <input type="file" accept=".html,.htm" style={{ display: 'none' }} onChange={handleUploadHtml} disabled={uploading} />
            </label>
            <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying || files.length === 0}>
              {deploying ? '部署中...' : project.current_url ? '重新部署' : '部署'}
            </button>
          </div>
        </div>
        <div className="card-body">
          {regenerateInfo && regenerateInfo.regenerateRequired && (
            <div className="regenerate-banner" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                ⚠ 检测到 Python 生成器，需重新生成 HTML 后才能部署
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>
                {regenerateInfo.regenerateRequired.message}
              </div>
              {regenerateInfo.regenerateRequired.hint && (() => {
                const cmd = buildRegenerateCmd(id, regenerateInfo.regenerateRequired.hint);
                return (
                  <div className="regenerate-cmd">
                    <code>{cmd}</code>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => {
                        navigator.clipboard?.writeText(cmd);
                        showToast('命令已复制');
                      }}
                    >
                      复制命令
                    </button>
                  </div>
                );
              })()}
              <div style={{ marginTop: 8 }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={handleForceDeploy}
                  disabled={deploying}
                >
                  {deploying ? '部署中...' : '仍要部署现有产物（跳过生成器检查）'}
                </button>
              </div>
            </div>
          )}
          {project.current_url ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: project.deploy_method === 'edgeone_deploying' ? 'var(--primary)' : project.deploy_method === 'local' || project.deploy_method === 'local_fallback' ? 'var(--orange)' : 'var(--green)' }}>
                  ● {project.deploy_method === 'edgeone' ? 'EdgeOne 在线预览' : project.deploy_method === 'edgeone_deploying' ? 'EdgeOne 构建中…' : project.deploy_method === 'edgeone_manual' ? 'EdgeOne 在线预览（手动）' : project.deploy_method === 'cloud_preview' ? 'EdgeOne 全栈预览' : '本地托管预览'}
                </span>
                <a href={project.current_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                  {project.current_url} ↗
                </a>
              </div>
              {project.deploy_method === 'local_fallback' && (
                <div style={{ padding: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 6, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: '#7c2d12', marginBottom: 8 }}>
                    EdgeOne Makers 部署可能已成功，但系统未能从 CLI 输出中解析出在线预览地址。如果 EdgeOne 给了你 URL，可点击下方按钮手动填入。
                  </div>
                  {!showManualUrl ? (
                    <button className="btn btn-sm btn-secondary" onClick={() => setShowManualUrl(true)}>手动填入 EdgeOne 在线地址</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="https://xxx.edgeone.dev?..."
                        value={manualUrl}
                        onChange={e => setManualUrl(e.target.value)}
                        style={{ flex: 1, fontSize: 13 }}
                      />
                      <button className="btn btn-sm btn-primary" onClick={handleSetManualUrl}>保存</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setShowManualUrl(false)}>取消</button>
                    </div>
                  )}
                </div>
              )}
              <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/project/${id}/review`)}>
                进入评审 →
              </button>
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>
              {files.length === 0 ? '请上传原型（ZIP 包 / 文件夹 / index.html）后部署' : '点击「部署」按钮将原型部署上线'}
            </div>
          )}
        </div>
      </div>

      {/* Dashboard layout: file tree + file viewer */}
      <div className="dashboard-layout">
        <div className="file-tree">
          <div className="file-tree-header">
            文件列表 ({files.length})
          </div>
          {files.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>暂无文件，请上传原型（ZIP 包 / 文件夹 / index.html）</div>
          ) : (
            files.map(f => (
              <div
                key={f.id}
                className={`file-tree-item ${selectedFile?.id === f.id ? 'active' : ''}`}
                onClick={() => handleSelectFile(f)}
              >
                <span>{fileIcon(f.path)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
              </div>
            ))
          )}
        </div>

        <div className="dashboard-main">
          {selectedFile ? (
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div className="card-header">
                <span className="card-title">{selectedFile.path}</span>
                {isTextFile(selectedFile.path) && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {editing ? (
                      <>
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>取消</button>
                        <button className="btn btn-sm btn-primary" onClick={handleSaveFile}>保存</button>
                      </>
                    ) : (
                      <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>编辑</button>
                    )}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                {isTextFile(selectedFile.path) ? (
                  editing ? (
                    <textarea
                      className="form-textarea"
                      style={{ width: '100%', minHeight: '400px', fontFamily: 'monospace', fontSize: 12 }}
                      value={fileContent}
                      onChange={e => setFileContent(e.target.value)}
                    />
                  ) : (
                    <pre style={{ fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{fileContent}</pre>
                  )
                ) : (
                  <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 48 }}>
                    二进制文件，无法预览
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48 }}>
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                <div className="empty-state-title">选择文件查看内容</div>
                <div className="empty-state-desc">点击左侧文件列表中的文件</div>
              </div>
            </div>
          )}

          {/* Recent deployments */}
          {deployments.length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">部署历史</span>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                {deployments.slice(0, 5).map(dep => (
                  <div key={dep.id} style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span className={`badge ${dep.status === 'success' ? 'badge-green' : dep.status === 'deploying' ? 'badge-blue' : 'badge-red'}`}>v{dep.version}</span>
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                        {dep.method === 'edgeone' ? 'EdgeOne' : dep.method === 'edgeone_deploying' ? 'EdgeOne 构建中' : dep.method === 'edgeone_manual' ? 'EdgeOne（手动）' : dep.method === 'cloud_preview' ? 'EdgeOne 全栈' : dep.method === 'local_fallback' ? '本地兜底' : '本地托管'} · {new Date(dep.created_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    {dep.url && <a href={dep.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>预览 ↗</a>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

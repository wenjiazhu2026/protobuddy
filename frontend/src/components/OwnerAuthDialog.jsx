import { useState } from 'react';

/**
 * Owner operation password dialog.
 * Shown when a protected operation is triggered without a valid session token.
 * Handles: wrong-password feedback with remaining attempts, and a lockout
 * countdown after too many consecutive failures.
 */
export default function OwnerAuthDialog({
  open,
  error,
  remainingAttempts,
  lockRemainingMs,
  onVerify,
  onCancel
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const locked = (lockRemainingMs || 0) > 0;

  if (!open) return null;

  const formatLock = (ms) => {
    const total = Math.ceil((ms || 0) / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  };

  const submit = async () => {
    if (!password.trim() || locked || submitting) return;
    setSubmitting(true);
    try {
      await onVerify(password.trim());
      setPassword('');
    } catch {
      // dialog state is driven by the context; just re-enable the button
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          owner 操作验证
          <button className="btn btn-sm btn-secondary" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            输入原型 owner 操作密码后，项目维护 / 文件上传 / 部署 / 方案审核 / 方案应用等受保护操作将无需再次输入。
          </div>
          {error && (
            <div className="auth-error">
              {error}
              {!locked && remainingAttempts != null && remainingAttempts > 0
                ? `（剩余 ${remainingAttempts} 次尝试机会）`
                : ''}
            </div>
          )}
          {locked && (
            <div className="auth-locked">
              连续失败次数过多，已临时锁定。请在 <strong>{formatLock(lockRemainingMs)}</strong> 后重试。
            </div>
          )}
          <input
            type="password"
            className="form-input"
            placeholder="请输入操作密码"
            value={password}
            disabled={locked || submitting}
            autoFocus
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            style={{ marginTop: 4 }}
          />
          <div className="auth-note">
            验证通过后当前浏览器会话内长期有效（口令会话不再自动过期）；关闭浏览器或清除会话数据后需重新输入。
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={locked || submitting || !password.trim()}
          >
            {submitting ? '验证中...' : '验证'}
          </button>
        </div>
      </div>
    </div>
  );
}

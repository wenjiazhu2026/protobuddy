import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, getOwnerToken, setOwnerToken } from '../api.js';
import OwnerAuthDialog from './OwnerAuthDialog.jsx';

const OwnerAuthContext = createContext(null);

/**
 * Guards owner-level operations:
 *  - First protected call: runs the action; a 401 OWNER_AUTH_REQUIRED response
 *    opens the password dialog and retries the original action automatically
 *    after a successful verification.
 *  - One-time per session: the verified token is stored in sessionStorage, so
 *    subsequent protected operations pass through without asking again.
 *  - Lockout: consecutive failures reach the server limit -> dialog shows a
 *    countdown and disables input until the lock expires.
 */
export function OwnerAuthProvider({ children }) {
  const [dialog, setDialog] = useState(null); // { projectId, error, remainingAttempts, lockRemainingMs }
  const pendingRef = useRef(null);            // { attempt, resolve, reject }
  const lockTimerRef = useRef(null);

  useEffect(() => {
    return () => { if (lockTimerRef.current) clearInterval(lockTimerRef.current); };
  }, []);

  const showDialog = useCallback((projectId, info = {}) => {
    setDialog({
      projectId,
      error: info.error || null,
      remainingAttempts: info.remainingAttempts != null ? info.remainingAttempts : null,
      lockRemainingMs: info.lockRemainingMs || 0
    });
  }, []);

  const startLockCountdown = useCallback((ms) => {
    if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    setDialog(d => d ? { ...d, lockRemainingMs: ms, error: null } : d);
    lockTimerRef.current = setInterval(() => {
      setDialog(d => {
        if (!d) return d;
        const next = Math.max(0, (d.lockRemainingMs || 0) - 1000);
        if (next <= 0) {
          clearInterval(lockTimerRef.current);
          lockTimerRef.current = null;
          return { ...d, lockRemainingMs: 0, error: null };
        }
        return { ...d, lockRemainingMs: next };
      });
    }, 1000);
  }, []);

  /**
   * Wrap a protected action: `guard(projectId, () => api.deploy(id, getOwnerToken(id)))`.
   * Resolves with the action result; rejects on real errors or when the user
   * cancels the password dialog.
   */
  const guard = useCallback((projectId, fn) => {
    return new Promise((resolve, reject) => {
      const attempt = () => Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch(err => {
          if (err && (err.code === 'OWNER_AUTH_REQUIRED' || err.code === 'OWNER_AUTH_LOCKED')) {
            pendingRef.current = { attempt, resolve, reject };
            showDialog(projectId, { lockRemainingMs: err.lock?.remainingLockMs || 0 });
          } else {
            reject(err);
          }
        });
      attempt();
    });
  }, [showDialog]);

  const handleVerify = useCallback(async (password) => {
    if (!dialog) return;
    const pid = dialog.projectId;
    const res = await api.verifyOwnerPassword(pid, password);
    setOwnerToken(pid, res.token);
    const pending = pendingRef.current;
    pendingRef.current = null;
    setDialog(null);
    if (pending) pending.attempt();
  }, [dialog]);

  const handleVerifyError = useCallback((err) => {
    if (!dialog) return;
    const pid = dialog.projectId;
    const locked = err.code === 'OWNER_AUTH_LOCKED' || (err.lock && err.lock.locked);
    if (locked) {
      showDialog(pid, { lockRemainingMs: err.lock?.remainingLockMs || 0 });
      startLockCountdown(err.lock?.remainingLockMs || 0);
    } else {
      showDialog(pid, { error: err.message || '操作密码错误', remainingAttempts: err.remainingAttempts });
    }
  }, [dialog, showDialog, startLockCountdown]);

  const handleCancel = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (lockTimerRef.current) { clearInterval(lockTimerRef.current); lockTimerRef.current = null; }
    setDialog(null);
    if (pending) pending.reject(new Error('owner verification cancelled'));
  }, []);

  /**
   * Manually open the password dialog (导航栏固定入口「操作密码」)。
   * Unlike guard(), no pending action is attached — a success just stores the
   * session token and closes. Can be invoked anytime to (re)enter / refresh
   * the操作密码 (token no longer expires; it lives for the browser session).
   */
  const openPasswordDialog = useCallback((projectId) => {
    if (!projectId) return;
    pendingRef.current = null;
    showDialog(projectId, {});
  }, [showDialog]);

  const contextValue = { guard, openPasswordDialog };

  return (
    <OwnerAuthContext.Provider value={contextValue}>
      {children}
      <OwnerAuthDialog
        open={!!dialog}
        error={dialog?.error}
        remainingAttempts={dialog?.remainingAttempts}
        lockRemainingMs={dialog?.lockRemainingMs}
        onVerify={(password) => handleVerify(password).catch(handleVerifyError)}
        onCancel={handleCancel}
      />
    </OwnerAuthContext.Provider>
  );
}

export function useOwnerAuth() {
  const ctx = useContext(OwnerAuthContext);
  if (!ctx) throw new Error('useOwnerAuth must be used within OwnerAuthProvider');
  return ctx;
}

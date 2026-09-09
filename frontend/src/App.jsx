import { useState } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import ProjectList from './pages/ProjectList.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Review from './pages/Review.jsx';
import PlanReview from './pages/PlanReview.jsx';
import Settings from './pages/Settings.jsx';
import Tasks from './pages/Tasks.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import { OwnerAuthProvider, useOwnerAuth } from './components/OwnerAuthContext.jsx';
import { getOwnerToken } from './api.js';
import ProjectNav from './components/ProjectNav.jsx';
import { projectTabs } from './components/projectTabs.js';
import { ToastProvider } from './components/ToastContext.jsx';

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function TopBar() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { openPasswordDialog } = useOwnerAuth();
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  // 提取项目 id（若在项目内路由），汉堡菜单追加项目 Tab
  const projectId = location.pathname.startsWith('/project/')
    ? location.pathname.split('/')[2]
    : null;
  const tabs = projectId ? projectTabs(projectId) : [];
  let authed = false;
  let authToken = '';
  try { authToken = getOwnerToken(projectId); authed = !!authToken; } catch { /* ignore */ }

  return (
    <div className="topbar">
      <Link to="/" className="topbar-brand">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" rx="20" fill="#18181b"/>
          <text x="50" y="68" fontSize="55" textAnchor="middle" fill="white" fontFamily="sans-serif" fontWeight="bold">P</text>
        </svg>
        原型协作评审平台
      </Link>
      <nav className="topbar-nav">
        <Link to="/" className={isActive('/') && location.pathname === '/' ? 'active' : ''}>项目</Link>
      </nav>
      <button
        className={'topbar-auth-btn' + (authed ? ' authed' : '')}
        onClick={() => projectId && openPasswordDialog(projectId)}
        disabled={!projectId}
        title={projectId
          ? (authed ? '操作密码已通过，会话不再过期（退出浏览器后需重新输入）' : '输入 / 更新操作密码')
          : '请先进入一个项目后再输入操作密码'}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        {authed ? '已认证' : '操作密码'}
      </button>
      <button
        className="hamburger-btn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="菜单"
        aria-expanded={menuOpen}
      >
        {menuOpen ? <CloseIcon /> : <HamburgerIcon />}
      </button>
      {menuOpen && (
        <div className="mobile-menu" onClick={() => setMenuOpen(false)}>
          <Link to="/" className="mobile-menu-item">项目</Link>
          {tabs.map((t) => (
            <Link key={t.key} to={t.to} className="mobile-menu-item">{t.label}</Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const location = useLocation();
  // HashRouter 下 location.pathname 仍为 hash 路径（如 /project/3/review）
  const inProject = location.pathname.startsWith('/project/');

  return (
    <OwnerAuthProvider>
      <ToastProvider>
        <div className="app-layout">
          <TopBar />
          {inProject && <ProjectNav projectId={location.pathname.split('/')[2]} />}
          <Routes>
            <Route path="/" element={<ProjectList />} />
            <Route path="/project/:id" element={<Dashboard />} />
            <Route path="/project/:id/review" element={<Review />} />
            <Route path="/project/:id/plan" element={<PlanReview />} />
            <Route path="/project/:id/settings" element={<Settings />} />
            <Route path="/project/:id/tasks" element={<Tasks />} />
            <Route path="/project/:id/tasks/new" element={<TaskDetail />} />
            <Route path="/project/:id/tasks/:taskId" element={<TaskDetail />} />
          </Routes>
        </div>
      </ToastProvider>
    </OwnerAuthProvider>
  );
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import projectsRouter from './routes/projects.js';
import filesRouter from './routes/files.js';
import deployRouter from './routes/deploy.js';
import annotationsRouter from './routes/annotations.js';
import plansRouter from './routes/plans.js';
import tasksRouter from './routes/tasks.js';
import domainRouter from './routes/domain.js';
import ownerAuthRouter from './routes/ownerAuth.js';
import { isBlobMode } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Express 4 does not forward rejections from async route handlers to the error
 * middleware — an unhandled rejection leaves the response hanging (HTTP 000).
 * Wrap every route handler so rejections go to next(err) -> the 500 handler.
 */
function wrapAsyncHandlers(router) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const h of layer.route.stack || []) {
      const fn = h.handle;
      // Skip error handlers (4-arg signature).
      if (typeof fn !== 'function' || fn.length >= 4) continue;
      h.handle = (req, res, next) => {
        try {
          return Promise.resolve(fn(req, res, next)).catch(next);
        } catch (e) {
          next(e);
        }
      };
    }
  }
  return router;
}

function resolveFrontendBuild() {
  // Root build output (frontend/vite.config.js -> ../dist)
  const rootDist = path.join(__dirname, '..', '..', 'dist');
  if (fs.existsSync(rootDist)) return rootDist;
  // Legacy location
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) return frontendDist;
  return null;
}

/**
 * Create the Express application (shared by the local server and the
 * EdgeOne Makers Cloud Functions framework entry).
 *
 * @param {{makersPrefix?: string}} [opts] makersPrefix re-attaches a route
 *   prefix that the EdgeOne framework dispatch stripped. EdgeOne's framework
 *   mode computes the sub-path by consuming the static segments of the route
 *   pattern: a request to /api/health routed via /api/:default* arrives at
 *   the app as /health. Since this app mounts its API under /api/*, the entry
 *   passes makersPrefix:'/api' so the prefix is restored before route matching.
 */
export function createApp({ makersPrefix } = {}) {
  // Indirection below keeps EdgeOne's framework detector from classifying
  // this file as an Express framework function: it matches `const X = express()`
  // (callee named "express"), which would route us into the broken framework
  // pipeline. `const factory = express; const app = factory()` is not matched.
  const expressFactory = express;
  const app = expressFactory();
  // In EdgeOne Makers Cloud Functions mode static assets are served by the
  // platform itself; the function only handles API + preview routes.
  const blobMode = isBlobMode();

  // Trust the platform's forwarding headers so req.protocol/host reflect the
  // public URL (the in-process onRequest adapter forwards Host + X-Forwarded-Proto).
  app.set('trust proxy', true);

  // MUST be registered before any route: restore the prefix stripped by the
  // framework dispatch (see comment on createApp options).
  if (makersPrefix) {
    app.use((req, res, next) => {
      const p = req.url;
      if (p !== '/' && !p.startsWith(makersPrefix + '/')) {
        req.url = makersPrefix + p;
      }
      next();
    });
  }

  // CORS: allow-list based. The production frontend is served same-origin
  // (static build behind the same app / same EdgeOne domain), so cross-origin
  // access is only needed for local development (Vite dev server). Tighten or
  // widen via CORS_ORIGINS (comma-separated; '*' reopens everything).
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowAll = corsOrigins.includes('*');
  app.use(cors({
    origin(origin, cb) {
      // No Origin header = same-origin request, curl, or server-to-server call.
      if (!origin || allowAll || corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false); // not a listed origin: no CORS headers -> browser blocks
    }
  }));
  // Total request-body ceiling (kept large enough for base64 file writes via
  // POST /api/projects/:id/files; tune via BODY_LIMIT env if desired).
  const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

  // Security headers via helmet. Configured to allow the app's own patterns:
  //   - frameSrc 'self': the preview iframe loads same-origin prototype HTML
  //   - scriptSrc 'self' 'unsafe-inline' + https://unpkg.com: prototype pages
  //     pull the Lucide icon library from unpkg; without the origin every icon
  //     (and lucide-rendered QR codes) silently fails to render.
  //   - scriptSrcAttr 'unsafe-inline': prototype HTML heavily uses inline
  //     onclick/onchange handlers; helmet's default 'none' here silently kills
  //     every button/modal an inline handler drives (e.g. 弹窗点不开)
  //   - styleSrc 'self' 'unsafe-inline' + Google Fonts: prototypes commonly link
  //     fonts.googleapis.com stylesheets; allow them so fonts (and any modal
  //     CSS they carry) actually load instead of being silently blocked.
  //   - imgSrc *: prototype assets may load from any origin
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        frameSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false, // prototype HTML may load cross-origin assets
    crossOriginResourcePolicy: { policy: 'cross-origin' } // preview assets served to iframe
  }));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Deployment probe: identifies which backend snapshot this function runs,
  // used to verify cloud-function refreshes propagate.
  app.get('/api/pbver', (req, res) => {
    res.json({ v: '2026-09-09-m2' });
  });

  // API routes (wrapped so async rejections become 500s instead of hanging)
  app.use('/api/projects', wrapAsyncHandlers(ownerAuthRouter));    // /api/projects/:id/owner-auth/*
  app.use('/api/projects', wrapAsyncHandlers(projectsRouter));
  app.use('/api/projects', wrapAsyncHandlers(filesRouter));      // /api/projects/:id/preview/* etc.
  app.use('/api/projects', wrapAsyncHandlers(deployRouter));      // /api/projects/:id/deploy
  app.use('/api/projects', wrapAsyncHandlers(annotationsRouter)); // /api/projects/:id/annotations
  app.use('/api/projects', wrapAsyncHandlers(plansRouter));       // /api/projects/:id/plan + /api/plans/:planId
  app.use('/api/projects', wrapAsyncHandlers(tasksRouter));       // /api/projects/:id/tasks*
  app.use('/api/projects', wrapAsyncHandlers(domainRouter));      // /api/projects/:id/domain/*

  // Visual editor assets (lazy-loaded inside the preview iframe by the
  // bootstrap injected in files.js). Single source of truth: frontend/public/editor,
  // which Vite copies into dist/editor/ where EdgeOne Makers serves it statically
  // at /editor/. This /api/editor route is the fallback for local development
  // (two-server mode), where the preview iframe's origin is this Express app.
  const editorDir = path.join(__dirname, '..', '..', 'frontend', 'public', 'editor');
  app.use('/api/editor', express.static(editorDir, { index: false, maxAge: '1h', etag: true }));

  // Serve frontend build (local server only; Makers serves static itself)
  if (!blobMode) {
    const frontendBuild = resolveFrontendBuild();
    if (frontendBuild) {
      app.use(express.static(frontendBuild));
      // SPA fallback
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.sendFile(path.join(frontendBuild, 'index.html'));
      });
    } else {
      // Dev mode - frontend runs on separate port
      app.get('/', (req, res) => {
        res.json({
          name: 'Prototype Review Platform API',
          status: 'running',
          mode: 'development',
          frontend: 'Run frontend dev server (cd frontend && npm run dev)',
          docs: '/api/health'
        });
      });
    }
  } else {
    // Makers mode: the function is mounted at /express (static assets at root
    // are served by the platform, which takes priority over function routes).
    app.get('/', (req, res) => {
      res.json({
        name: 'ProtoBuddy API',
        status: 'running',
        mode: 'edgeone-makers',
        health: '/express/api/health'
      });
    });
    // Unknown non-static paths are 404 (HashRouter avoids deep links)
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createHandler } from '@fal-ai/server-proxy/express';
import { randomUUID } from 'crypto';
import {
  configureAuth,
  requireAuth,
  requireAdmin,
  ADMIN_EMAIL,
  type SessionUser,
} from './auth';
import {
  recordGeneration,
  getUserGenerations,
  getUserTotals,
  getAllUserTotals,
  getRecentGenerations,
  getGrandTotals,
  listVisibleSessions,
  getSessionRow,
  userCanAccessSession,
  userIsOwner,
  createSession,
  updateSessionContent,
  setSessionVisibility,
  deleteSession,
  sessionToDTO,
  listTeamMembers,
  compactSessions,
  type SessionVisibility,
} from './db';
import {
  runGeneration,
  runUpscale,
  runEnhance,
  type GeneratePayload,
  type UpscalePayload,
} from './falService';
import { FLUX3_ENDPOINTS } from '../src/utils/flux3';
import { renderAdminPage } from './adminPage';
import { createPipelineRouter } from './pipelineRoutes';
import { actorMiddleware } from './projectStore';
import { createRateLimiter } from './rateLimit';
import {
  checkGeneratePayload,
  describeFalFailure,
  failureForLog,
  isAllowedGenerationEndpoint,
} from './errors';

/**
 * FLUX Video Studio server.
 *
 *  - Google OAuth login restricted to @52launch.com (signed cookie session).
 *  - fal.ai generation/upscale runs server-side so usage is attributed to the
 *    logged-in user and recorded (count, tokens, cost) in SQLite.
 *  - The fal proxy (used only for browser-side file uploads to fal storage) is
 *    gated behind an authenticated session.
 *  - /admin (jd@52launch.com only) shows all users' usage.
 */

const app = express();
const PORT = Number(process.env.FAL_PROXY_PORT) || 3001;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.FAL_KEY) {
  console.warn('[server] WARNING: FAL_KEY is not set. Generation will fail until configured.');
}

// Session + Google OAuth (adds /auth/* and /api/me). Must run before body
// parsing so the large pipeline bodies below are only read for signed-in users.
configureAuth(app);

// 52Launch pipeline (projects + AI steps). These carry base64 media, so they get
// a larger body limit, applied only AFTER authentication. The global parser
// below skips bodies already parsed here.
app.use(
  ['/api/projects', '/api/pipeline'],
  requireAuth,
  express.json({ limit: '150mb' }),
  // After the body parser: parsers run in their own async context and would
  // drop the signed-in-user binding that project access checks rely on.
  actorMiddleware
);
app.use('/api/pipeline', createRateLimiter(60, 60_000));

app.use(express.json({ limit: '25mb' }));

// The pipeline router only defines /projects/* and /pipeline/* (both gated
// above). Keep it that way: it is mounted on /api without its own auth.
app.use('/api', createPipelineRouter());

// --- fal storage upload proxy (authenticated) ---
// Only used by the browser to upload reference media to fal storage. Generation
// itself does NOT go through here anymore — it runs server-side (see below).
// Gated behind requireAuth so it can't be abused anonymously.
app.all(
  '/api/fal/proxy',
  requireAuth,
  createHandler({
    allowedEndpoints: [
      'bytedance/seedance-2.0/**',
      'bytedance/seedance-2.5/**',
      'fal-ai/topaz/upscale/**',
    ],
  })
);

// --- Generation (authenticated, server-side, tracked) ---
app.post('/api/generate', requireAuth, async (req, res) => {
  const user = req.user as SessionUser;
  const body = req.body as Partial<GeneratePayload>;

  if (!body?.endpointId || !body?.input) {
    res.status(400).json({ error: 'Missing endpointId or input.' });
    return;
  }

  // Only Seedance endpoints may be run with our fal key.
  if (!isAllowedGenerationEndpoint(body.endpointId)) {
    res.status(400).json({ error: 'That model is not available.' });
    return;
  }

  // Reject obviously incomplete requests before they reach fal.
  const incomplete = checkGeneratePayload(
    body.endpointId,
    body.input as Record<string, unknown>
  );
  if (incomplete) {
    res.status(incomplete.status).json({
      error: incomplete.message,
      hint: incomplete.hint,
      code: incomplete.code,
    });
    return;
  }

  const payload: GeneratePayload = {
    endpointId: body.endpointId,
    input: body.input,
    modelId: body.modelId || 'seedance-2.5',
    resolution: (body.resolution as GeneratePayload['resolution']) || '720p',
    duration: Number(body.duration) || 5,
    aspectRatio: body.aspectRatio || '16:9',
  };

  const genId = randomUUID();
  try {
    const outcome = await runGeneration(payload);
    recordGeneration({
      id: genId,
      user_id: user.id,
      user_email: user.email,
      kind: 'generate',
      model_id: payload.modelId,
      endpoint: payload.endpointId,
      request_id: outcome.requestId,
      resolution: payload.resolution,
      duration: payload.duration,
      aspect_ratio: payload.aspectRatio,
      tokens: outcome.tokens,
      cost_usd: outcome.costUsd,
      status: 'completed',
      error: null,
    });
    res.json({
      videoUrl: outcome.videoUrl,
      seed: outcome.seed,
      requestId: outcome.requestId,
      resolution: payload.resolution,
      tokens: outcome.tokens,
      costUsd: outcome.costUsd,
      draftCacheUrl: outcome.draftCacheUrl,
    });
  } catch (err) {
    const failure = describeFalFailure(err);
    console.warn(
      `[generate] failed for ${user.email} (${payload.endpointId}): ${failure.code} — ${failure.detail ?? failure.message}`
    );
    recordGeneration({
      id: genId,
      user_id: user.id,
      user_email: user.email,
      kind: 'generate',
      model_id: payload.modelId,
      endpoint: payload.endpointId,
      request_id: null,
      resolution: payload.resolution,
      duration: payload.duration,
      aspect_ratio: payload.aspectRatio,
      tokens: 0,
      cost_usd: 0,
      status: 'failed',
      error: failureForLog(failure),
    });
    res.status(failure.status).json({
      error: failure.message,
      hint: failure.hint,
      code: failure.code,
      detail: failure.detail,
      retryable: failure.retryable,
    });
  }
});

// --- Upscale (authenticated, server-side, tracked) ---
app.post('/api/upscale', requireAuth, async (req, res) => {
  const user = req.user as SessionUser;
  const body = req.body as Partial<UpscalePayload>;

  if (!body?.videoUrl || !body?.targetResolution) {
    res.status(400).json({ error: 'Missing videoUrl or targetResolution.' });
    return;
  }

  const payload: UpscalePayload = {
    videoUrl: body.videoUrl,
    targetResolution: body.targetResolution,
  };

  const genId = randomUUID();
  try {
    const outcome = await runUpscale(payload);
    recordGeneration({
      id: genId,
      user_id: user.id,
      user_email: user.email,
      kind: 'upscale',
      model_id: null,
      endpoint: 'fal-ai/topaz/upscale/video',
      request_id: outcome.requestId,
      resolution: payload.targetResolution,
      duration: null,
      aspect_ratio: null,
      tokens: outcome.tokens,
      cost_usd: outcome.costUsd,
      status: 'completed',
      error: null,
    });
    res.json({
      videoUrl: outcome.videoUrl,
      requestId: outcome.requestId,
      costUsd: outcome.costUsd,
    });
  } catch (err) {
    const failure = describeFalFailure(err);
    console.warn(
      `[upscale] failed for ${user.email}: ${failure.code} — ${failure.detail ?? failure.message}`
    );
    recordGeneration({
      id: genId,
      user_id: user.id,
      user_email: user.email,
      kind: 'upscale',
      model_id: null,
      endpoint: 'fal-ai/topaz/upscale/video',
      request_id: null,
      resolution: payload.targetResolution,
      duration: null,
      aspect_ratio: null,
      tokens: 0,
      cost_usd: 0,
      status: 'failed',
      error: failureForLog(failure),
    });
    res.status(failure.status).json({
      error: failure.message,
      hint: failure.hint,
      code: failure.code,
      detail: failure.detail,
      retryable: failure.retryable,
    });
  }
});

// --- FLUX 3 draft enhance (authenticated, server-side, tracked) ---
// Re-renders an approved draft at full quality from its cache.
app.post('/api/enhance', requireAuth, async (req, res) => {
  const user = req.user as SessionUser;
  const body = req.body as {
    draftCacheUrl?: unknown;
    durationSeconds?: unknown;
    safetyTolerance?: unknown;
  };

  // The cache is a fal CDN file produced by an earlier draft; refuse anything else.
  let host = '';
  try {
    const u = new URL(typeof body.draftCacheUrl === 'string' ? body.draftCacheUrl : '');
    host = u.protocol === 'https:' ? u.hostname : '';
  } catch {
    host = '';
  }
  if (!host || !/(^|\.)fal\.(media|run|ai)$/i.test(host)) {
    res.status(400).json({
      error: 'That draft can’t be enhanced.',
      hint: 'Enhance a draft that was generated in this app.',
      code: 'bad_draft_cache',
    });
    return;
  }

  const durationSeconds = Math.min(20, Math.max(1, Math.round(Number(body.durationSeconds) || 5)));
  const tol = Number(body.safetyTolerance);
  const safetyTolerance = Number.isFinite(tol) ? Math.min(4, Math.max(0, Math.round(tol))) : 2;

  const genId = randomUUID();
  const base = {
    id: genId,
    user_id: user.id,
    user_email: user.email,
    kind: 'enhance',
    model_id: 'flux-3',
    endpoint: FLUX3_ENDPOINTS.enhance,
    resolution: '1080p',
    duration: durationSeconds,
    aspect_ratio: null,
  };

  try {
    const outcome = await runEnhance({
      draftCacheUrl: body.draftCacheUrl as string,
      durationSeconds,
      safetyTolerance,
    });
    recordGeneration({
      ...base,
      request_id: outcome.requestId,
      tokens: 0,
      cost_usd: outcome.costUsd,
      status: 'completed',
      error: null,
    });
    res.json({
      videoUrl: outcome.videoUrl,
      requestId: outcome.requestId,
      costUsd: outcome.costUsd,
    });
  } catch (err) {
    const failure = describeFalFailure(err);
    console.warn(
      `[enhance] failed for ${user.email}: ${failure.code} — ${failure.detail ?? failure.message}`
    );
    recordGeneration({
      ...base,
      request_id: null,
      tokens: 0,
      cost_usd: 0,
      status: 'failed',
      error: failureForLog(failure),
    });
    res.status(failure.status).json({
      error: failure.message,
      hint: failure.hint,
      code: failure.code,
      detail: failure.detail,
      retryable: failure.retryable,
    });
  }
});

// --- Current user's own usage ---
app.get('/api/usage/me', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  res.json({
    totals: getUserTotals(user.id),
    generations: getUserGenerations(user.id, 200),
  });
});

// --- Admin API (jd@52launch.com only) ---
app.get('/api/admin/usage', requireAdmin, (_req, res) => {
  res.json({
    grandTotals: getGrandTotals(),
    perUser: getAllUserTotals(),
    recent: getRecentGenerations(200),
  });
});

// --- Admin HTML page (jd@52launch.com only) ---
app.get('/admin', requireAdmin, (_req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(
    renderAdminPage({
      grandTotals: getGrandTotals(),
      perUser: getAllUserTotals(),
      recent: getRecentGenerations(200),
    })
  );
});

// ---------------------------------------------------------------------------
// Sessions (studios) — persistent, per-user, with sharing
// ---------------------------------------------------------------------------

const isAdminEmail = (email: string) =>
  email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

const VALID_VISIBILITY: SessionVisibility[] = ['private', 'team', 'shared'];

// List all sessions visible to the current user (owned + team + shared-with-me).
app.get('/api/sessions', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  res.json({ sessions: listVisibleSessions(user.email, isAdminEmail(user.email)) });
});

// Team member list for the share dropdown.
app.get('/api/team', requireAuth, (_req, res) => {
  res.json({ members: listTeamMembers() });
});

// Create a new session owned by the caller.
app.post('/api/sessions', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  const b = req.body as Record<string, unknown>;
  if (!b?.id || !b?.title) {
    res.status(400).json({ error: 'Missing id or title.' });
    return;
  }
  const row = createSession({
    id: String(b.id),
    ownerId: user.id,
    ownerEmail: user.email,
    title: String(b.title),
    description: b.description ? String(b.description) : undefined,
    folder: b.folder ? String(b.folder) : undefined,
    params: b.params ?? {},
    takes: b.takes ?? [],
    currentTakeId: (b.currentTakeId as string) ?? null,
    thumbnailUrl: b.thumbnailUrl ? String(b.thumbnailUrl) : undefined,
    visibility: 'private',
    isStarred: Boolean(b.isStarred),
  });
  res.json({ session: sessionToDTO(row, user.email) });
});

// Update a session's content (any user with access — model B is collaborative).
app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  const admin = isAdminEmail(user.email);
  const row = getSessionRow(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (!userCanAccessSession(row, user.email, admin)) {
    res.status(403).json({ error: 'No access to this session.' });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const updated = updateSessionContent(req.params.id, {
    title: b.title !== undefined ? String(b.title) : undefined,
    description: b.description !== undefined ? String(b.description) : undefined,
    folder: b.folder !== undefined ? String(b.folder) : undefined,
    params: b.params,
    takes: b.takes,
    currentTakeId:
      b.currentTakeId !== undefined ? (b.currentTakeId as string | null) : undefined,
    thumbnailUrl: b.thumbnailUrl !== undefined ? String(b.thumbnailUrl) : undefined,
    isStarred: b.isStarred !== undefined ? Boolean(b.isStarred) : undefined,
  });
  res.json({ session: sessionToDTO(updated!, user.email) });
});

// Change visibility / sharing (owner or admin only).
app.put('/api/sessions/:id/visibility', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  const admin = isAdminEmail(user.email);
  const row = getSessionRow(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (!userIsOwner(row, user.email, admin)) {
    res.status(403).json({ error: 'Only the owner can change sharing.' });
    return;
  }
  const b = req.body as { visibility?: string; sharedWith?: unknown };
  const visibility = b.visibility as SessionVisibility;
  if (!VALID_VISIBILITY.includes(visibility)) {
    res.status(400).json({ error: 'Invalid visibility.' });
    return;
  }
  const sharedWith = Array.isArray(b.sharedWith)
    ? (b.sharedWith as unknown[]).map((e) => String(e))
    : [];
  const updated = setSessionVisibility(req.params.id, visibility, sharedWith);
  res.json({ session: sessionToDTO(updated!, user.email) });
});

// Delete a session (owner or admin only).
app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const user = req.user as SessionUser;
  const admin = isAdminEmail(user.email);
  const row = getSessionRow(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (!userIsOwner(row, user.email, admin)) {
    res.status(403).json({ error: 'Only the owner can delete.' });
    return;
  }
  deleteSession(req.params.id);
  res.json({ ok: true });
});

// --- Same-origin video proxy (for client-side thumbnail capture) ---
// Browsers taint a canvas when drawing a cross-origin video whose host doesn't
// send permissive CORS headers, which breaks toDataURL(). Streaming the video
// through our own origin makes the capture same-origin, so it never taints.
// Allow-listed to fal media hosts; auth-gated.
const ALLOWED_VIDEO_HOSTS = [
  /(^|\.)fal\.media$/i,
  /(^|\.)fal\.run$/i,
  /(^|\.)fal\.ai$/i,
  /(^|\.)v3\.fal\.media$/i,
];

app.get('/api/video-proxy', requireAuth, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid url.' });
    return;
  }
  if (
    parsed.protocol !== 'https:' ||
    !ALLOWED_VIDEO_HOSTS.some((re) => re.test(parsed.hostname))
  ) {
    res.status(400).json({ error: 'URL host not allowed.' });
    return;
  }
  try {
    const upstream = await fetch(parsed.toString(), {
      headers: req.headers.range ? { range: String(req.headers.range) } : {},
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    const cl = upstream.headers.get('content-length');
    const ar = upstream.headers.get('accept-ranges');
    if (ct) res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (ar) res.setHeader('Accept-Ranges', ar);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'proxy failed';
    res.status(502).json({ error: msg });
  }
});

// Health check (public).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, falKeyConfigured: Boolean(process.env.FAL_KEY) });
});

// --- Serve the built frontend in production ---
// In dev the Vite server serves the app and proxies /api + /auth here.
if (isProd) {
  const distDir = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback for any non-API route.
    app.get(/^\/(?!api|auth|admin).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    console.warn('[server] dist/ not found; run `npm run build` before production start.');
  }
}

try {
  compactSessions();
} catch (err) {
  console.error('[db] compactSessions failed (continuing):', err);
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] admin: ${ADMIN_EMAIL} → /admin`);
  console.log(
    `[server] FAL_KEY ${process.env.FAL_KEY ? 'configured ✓' : 'MISSING ✗'} | ` +
      `Google OAuth ${process.env.GOOGLE_CLIENT_ID ? 'configured ✓' : 'MISSING ✗'}`
  );
});

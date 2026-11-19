import fs from 'fs/promises';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type {
  PipelineProject,
  PipelineStepNumber,
  ProjectSummary,
  ProjectThumbnailItem,
  ProjectVisibility,
} from '../src/types/pipeline.ts';
import { db } from './db';
import { ADMIN_EMAIL, type SessionUser } from './auth';

/**
 * Pipeline project storage (hybrid).
 *
 *  - Project records live in SQLite (table `pipeline_projects`, same app.db as
 *    users and usage). Each record has an owner, a visibility and a version
 *    number used to detect two people editing the same project.
 *  - Media files (images, audio, video, PDFs) stay on disk under
 *    DATA_DIR/assets/<projectId>/, so the database stays small.
 *
 * The functions keep the same names and signatures as the original file-based
 * store so the route code is unchanged. Who is asking is carried by an
 * AsyncLocalStorage "actor" that `actorMiddleware` sets once per request, so no
 * route can forget to apply the access check.
 */

/** Visibility given to new projects. 'team' = every signed-in @52launch.com user. */
export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = 'team';

function getDataRoot(): string {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_projects (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    owner_email   TEXT NOT NULL,
    visibility    TEXT NOT NULL DEFAULT 'team',   -- 'private' | 'team'
    version       INTEGER NOT NULL DEFAULT 1,
    client        TEXT,
    product_name  TEXT,
    data          TEXT NOT NULL,                  -- JSON PipelineProject
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_projects_owner ON pipeline_projects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_projects_updated ON pipeline_projects(updated_at);
`);

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

interface Actor {
  id: string;
  email: string;
  isAdmin: boolean;
}

const actorStore = new AsyncLocalStorage<Actor>();

/** Error carrying an HTTP status so routes can answer 403/409 instead of 500. */
export class ProjectAccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProjectAccessError';
    this.status = status;
  }
}

/** Raised when a save is based on an older version than the stored one. */
export class ProjectConflictError extends ProjectAccessError {
  currentVersion: number;
  constructor(currentVersion: number) {
    super(
      409,
      'This project was changed by someone else (or in another tab) since you opened it. Reload it to see the latest version before saving.'
    );
    this.name = 'ProjectConflictError';
    this.currentVersion = currentVersion;
  }
}

/**
 * Express middleware: binds the signed-in user to the rest of the request.
 * Mount it AFTER body parsing (body parsers run in a different async context
 * and would drop the binding) and after requireAuth.
 */
export function actorMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = req.user as SessionUser | undefined;
  if (!user?.email) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const email = user.email.toLowerCase();
  actorStore.run({ id: user.id, email, isAdmin: email === ADMIN_EMAIL.toLowerCase() }, next);
}

/** Runs `fn` as a given user (tests, scripts). */
export function runAsActor<T>(a: Actor, fn: () => T): T {
  return actorStore.run(a, fn);
}

function currentActor(): Actor {
  const a = actorStore.getStore();
  // Fail closed: a code path that forgot the middleware must not read or write.
  if (!a) throw new ProjectAccessError(401, 'Authentication required.');
  return a;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  owner_email: string;
  visibility: ProjectVisibility;
  version: number;
  data: string;
  created_at: number;
  updated_at: number;
}

const canRead = (row: Pick<ProjectRow, 'owner_id' | 'visibility'>, a: Actor): boolean =>
  a.isAdmin || row.owner_id === a.id || row.visibility === 'team';

// Everyone who can read a team project can edit it; private projects are owner-only.
const canWrite = canRead;

const canDelete = (row: Pick<ProjectRow, 'owner_id'>, a: Actor): boolean =>
  a.isAdmin || row.owner_id === a.id;

function getRow(id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM pipeline_projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
}

/** True when the signed-in user may read the project's files. */
export function canReadProject(projectId: string): boolean {
  const a = currentActor();
  const row = getRow(sanitizeId(projectId));
  return Boolean(row && canRead(row, a));
}

/**
 * Asset writes are allowed into a project the user can edit, or into a brand
 * new id (a project being created uploads its photos before it is saved).
 */
function assertCanWriteAssets(projectId: string): void {
  const a = currentActor();
  const row = getRow(sanitizeId(projectId));
  if (row && !canWrite(row, a)) {
    throw new ProjectAccessError(403, 'You do not have access to this project.');
  }
}

function rowToProject(row: ProjectRow, a: Actor): PipelineProject {
  const parsed = JSON.parse(row.data) as PipelineProject;
  return {
    ...parsed,
    id: row.id,
    version: row.version,
    ownerEmail: row.owner_email,
    visibility: row.visibility,
    isOwner: row.owner_id === a.id,
  };
}

const MIME_TO_ASSET_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

const EXT_TO_ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

export function isSupportedAssetFilename(filename: string): boolean {
  if (!filename || filename.startsWith('.') || filename.includes('/') || filename.includes('\\')) {
    return false;
  }
  const ext = path.extname(filename).toLowerCase();
  return Boolean(EXT_TO_ASSET_MIME[ext]);
}

function sanitizeAssetPrefix(raw: string | undefined, fallback = 'asset'): string {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || fallback;
}

function normalizeSupportedExt(rawExt: string | undefined): string {
  const cleaned = String(rawExt || '')
    .toLowerCase()
    .replace(/^\./, '');
  if (!cleaned || !EXT_TO_ASSET_MIME[`.${cleaned}`]) {
    throw new Error(
      `Unsupported asset file extension ".${cleaned || 'unknown'}". Allowed: image, audio, video, and PDF files.`
    );
  }
  return cleaned === 'jpeg' ? 'jpg' : cleaned;
}

function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TO_ASSET_MIME[ext] || 'application/octet-stream';
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `proj-${Date.now()}`;
}

export function getProjectAssetsDir(projectId: string): string {
  return path.join(getDataRoot(), 'assets', sanitizeId(projectId));
}

export async function saveDataUrlAsset(
  projectId: string,
  dataUrl: string,
  prefix = 'asset'
): Promise<{ url: string; filename: string }> {
  assertCanWriteAssets(projectId);
  const assetsDir = getProjectAssetsDir(projectId);
  await ensureDir(assetsDir);

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid file upload format.');
  }
  const mime = match[1].toLowerCase().trim();
  const base64Data = match[2];
  const ext = MIME_TO_ASSET_EXT[mime];
  if (!ext) {
    throw new Error(
      `Unsupported file type "${mime}". Allowed formats: PNG, JPG, WEBP, GIF, MP4, MOV, WEBM, MP3, WAV, M4A, OGG, AAC, and PDF.`
    );
  }

  const safePrefix = sanitizeAssetPrefix(prefix, 'asset');
  const filename = `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));

  return {
    filename,
    url: `/api/projects/${sanitizeId(projectId)}/assets/${filename}`,
  };
}

export async function saveBinaryAssetFromUrl(
  projectId: string,
  remoteUrl: string,
  prefix = 'video',
  ext = 'mp4'
): Promise<{ url: string; filename: string }> {
  assertCanWriteAssets(projectId);
  const assetsDir = getProjectAssetsDir(projectId);
  await ensureDir(assetsDir);

  const safeExt = normalizeSupportedExt(ext);
  const safePrefix = sanitizeAssetPrefix(prefix, 'video');

  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Could not download generated media (${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const filename = `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${safeExt}`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  return {
    filename,
    url: `/api/projects/${sanitizeId(projectId)}/assets/${filename}`,
  };
}

export async function saveBufferAsset(
  projectId: string,
  buffer: Buffer,
  prefix = 'vo',
  ext = 'wav'
): Promise<{ url: string; filename: string }> {
  assertCanWriteAssets(projectId);
  const assetsDir = getProjectAssetsDir(projectId);
  await ensureDir(assetsDir);

  const safeExt = normalizeSupportedExt(ext);
  const safePrefix = sanitizeAssetPrefix(prefix, 'vo');
  const filename = `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${safeExt}`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, buffer);

  return {
    filename,
    url: `/api/projects/${sanitizeId(projectId)}/assets/${filename}`,
  };
}

export async function readAssetAsInlineData(
  projectId: string,
  assetUrlOrDataUrl: string
): Promise<{ data: string; mimeType: string } | null> {
  if (!assetUrlOrDataUrl) return null;

  if (assetUrlOrDataUrl.startsWith('data:')) {
    const match = assetUrlOrDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
  }

  // Handle /api/projects/:id/assets/:filename
  const apiPrefix = `/api/projects/${sanitizeId(projectId)}/assets/`;
  let filePath: string | null = null;
  if (assetUrlOrDataUrl.startsWith(apiPrefix)) {
    if (!canReadProject(projectId)) return null;
    const filename = path.basename(assetUrlOrDataUrl);
    if (!isSupportedAssetFilename(filename)) return null;
    filePath = path.join(getProjectAssetsDir(projectId), filename);
  } else if (assetUrlOrDataUrl.startsWith('/src/assets/')) {
    const allowedAssetsDir = path.resolve(process.cwd(), 'src', 'assets');
    const candidatePath = path.resolve(process.cwd(), assetUrlOrDataUrl.slice(1));
    if (!candidatePath.startsWith(allowedAssetsDir + path.sep)) {
      return null;
    }
    filePath = candidatePath;
  }

  if (!filePath) return null;

  try {
    const buffer = await fs.readFile(filePath);
    const mimeType = getMimeFromFilename(filePath);
    if (mimeType === 'application/octet-stream') return null;
    return {
      data: buffer.toString('base64'),
      mimeType,
    };
  } catch {
    return null;
  }
}

export async function seedInitialProjectIfEmpty(): Promise<void> {
  // Opt-in (development and smoke tests): production should start empty, not
  // with a demo client in everyone's project list.
  if (process.env.SEED_SAMPLE_PROJECT !== 'true') return;
  const existing = db.prepare('SELECT COUNT(*) AS n FROM pipeline_projects').get() as {
    n: number;
  };
  if (existing.n > 0) return;

  const sampleId = 'kinetix-core-patch';
  const now = new Date().toISOString();

  // Copy sample asset from src/assets/images if available so sample project has a real product photo
  let samplePhotoUrl = '';
  try {
    const srcImagesDir = path.resolve(process.cwd(), 'src', 'assets', 'images');
    const files = await fs.readdir(srcImagesDir);
    const propFile = files.find((f) => f.includes('sample_prop_patch'));
    if (propFile) {
      await ensureDir(getProjectAssetsDir(sampleId));
      const destFile = 'product-hero-patch.jpg';
      await fs.copyFile(
        path.join(srcImagesDir, propFile),
        path.join(getProjectAssetsDir(sampleId), destFile)
      );
      samplePhotoUrl = `/api/projects/${sampleId}/assets/${destFile}`;
    }
  } catch {
    // Optional sample image copy
  }

  const starterProject: PipelineProject = {
    id: sampleId,
    createdAt: now,
    updatedAt: now,
    client: 'Kinetix Bio Inc.',
    product: {
      name: 'Kinetix Core Patch',
      description:
        'A 1.2mm ultra-thin wearable sweat-sensing biometric patch that sticks to the forearm and measures real-time electrolyte loss and lactate threshold during endurance training.',
      provableClaims: [
        'Measures sweat sodium concentration and fluid loss continuously in real time',
        '1.2mm low-profile medical-grade adhesive housing',
        'Alerts athletes via companion watch/phone 15–20 minutes before dehydration fatigue sets in',
      ],
      photos: samplePhotoUrl
        ? [
            {
              id: 'photo-seed-1',
              url: samplePhotoUrl,
              caption: 'Kinetix Core Patch faceted anodized aluminum ring & polymer core',
            },
          ]
        : [],
    },
    intake: {
      audience:
        'Competitive marathoners, triathletes, and serious endurance runners aged 24–42 who already train with GPS watches.',
      tone: 'Visceral, athletic, disciplined, documentary realism — zero hype or neon gym clichés.',
      clientMarketingIdeas:
        'Open on a solo runner hitting a dawn track before anyone else is awake. Show the moment they normally bonk at mile 20, except this time they get an early hydration warning and surge past it.',
      videosWanted: '1x 30s Launch Hero Spot (16:9), 2x 15s Paid Social Cutdowns (9:16)',
      shootLocationDatesBudgetNotes:
        'Civic stadium running track in Los Angeles. Target shoot window: early December dawn call (5:45 AM – 10:30 AM). Budget tier: lean 1-day exterior location crew.',
    },
    brandBible: {
      positioning:
        'Kinetix Core Patch gives endurance athletes a twenty-minute biological warning before dehydration breaks their race.',
      audience:
        'Data-driven marathoners and triathletes (24–42) who track splits, heart rate, and fueling precision.',
      toneOfVoice: {
        adjectives: ['Disciplined', 'Visceral', 'Precise', 'Grounded'],
        guidance:
          'Speak in calm, direct athletic truths. Avoid breathless tech buzzwords, exclamation marks, or unproven medical promises.',
      },
      visualStyle: {
        palette: 'Asphalt black (#0F172A), brutalist concrete slate (#334155), dawn mist white (#F8FAFC), and amber telemetry highlights (#F59E0B).',
        typography: 'Primary Display: Neue Haas Grotesk Bold; Body & Subheads: Inter Medium; Telemetry Readouts: JetBrains Mono Regular.',
        lighting: 'Low-angle natural dawn sunlight cutting across concrete bleachers with crisp negative fill.',
        lensAndFraming: '35mm and 85mm anamorphic primes for track action; 100mm macro for skin-patch detail.',
        grade: 'Rich monochrome-leaning contrast with natural warm skin tones.',
      },
      brandLogoUrl: null,
      brandLogoCaption: '',
      characters: [
        {
          id: 'char-1',
          name: 'Maya (Lead Runner)',
          fixedDescriptor:
            'Maya, athletic woman in her late 20s with dark hair tied in a high bun, wearing a matte black technical running singlet, dark split shorts, and a GPS watch on her right wrist',
        },
      ],
      productRules:
        'Circular 32mm ultra-thin disc worn on the outer left forearm, brushed faceted outer ring with matte center and a single subtle amber indicator dot. Never show holographic floating screens or glowing sci-fi overlays.',
      bannedList: [
        'Neon gym lighting',
        'Holographic HUD graphics floating in mid-air',
        'Smiling stock-photo poses',
        'Unproven medical cure claims',
      ],
      claimsAllowed: [
        'Measures sweat sodium concentration and fluid loss continuously in real time',
        '1.2mm low-profile medical-grade adhesive housing',
        'Alerts athletes via companion watch/phone 15–20 minutes before dehydration fatigue sets in',
      ],
      claimsToFlag: [
        'Client idea mentions "surge past mile 20" — ensure voiceover frames this as hydration readiness rather than guaranteeing faster marathon times.',
      ],
      hasGenerated: true,
      manuallyEdited: false,
    },
    creativeBrief: {
      objective:
        'Introduce Kinetix Core Patch to serious endurance athletes and drive pre-order reservations for Batch 01.',
      keyMessage:
        'Dehydration starts twenty minutes before you feel thirsty — Kinetix lets you hear the warning in time.',
      concepts: [
        {
          id: 'concept-1',
          title: 'Twenty Minutes Early',
          logline:
            'A lone marathoner runs dawn intervals on a brutalist track as real-time sweat telemetry prevents the invisible wall before it hits.',
          whyItWorks:
            'Grounds the client’s dawn track idea in an authentic sensory experience athletes immediately recognize.',
          risks: 'Requires tight dawn light window (6:00–7:30 AM) for wide stadium shots.',
        },
        {
          id: 'concept-2',
          title: 'The Salt Line',
          logline:
            'Tight macro textures of salt on skin, shoe rubber on asphalt, and the 1.2mm patch reading every drop.',
          whyItWorks: 'Turns invisible sweat chemistry into tactile cinema.',
          risks: 'Needs careful macro moisture control on set.',
        },
      ],
      recommendedConcept: {
        title: 'Twenty Minutes Early',
        reason:
          'Balances emotional human grit with clear, provable product utility across both 30s hero and 15s social cutdowns.',
      },
      deliverables: ['1x 30s Launch Hero Spot (16:9)', '2x 15s Paid Social Cutdowns (9:16)'],
      voDirection: {
        pace: 'Measured and steady at opening, tightening cleanly into the final surge (~2.5 words/sec).',
        emotionalArc: 'Quiet internal focus -> subtle tension -> calm athletic mastery.',
        speaker: 'Maya or seasoned endurance coach voice (warm, gravelly, unhurried).',
      },
      claimsCheck:
        'All lines stick strictly to real-time sweat sodium/fluid measurement, 1.2mm profile, and 15–20 minute early hydration alert.',
      hasGenerated: true,
      manuallyEdited: false,
    },
    shots: [
      {
        id: 'S01',
        deliverable: '30s Hero',
        durationSec: 5,
        scene: 'Wide dawn silhouette of Maya walking onto Lane 1 of an empty concrete stadium track.',
        route: 'ai_video',
        model: 'seedance',
        productInFrame: false,
        framePrompt:
          'Wide establishing 35mm anamorphic shot at early dawn of a brutalist concrete stadium running track in light mist. Maya, athletic woman in her late 20s with dark hair tied in a high bun, wearing a matte black technical running singlet, dark split shorts, and a GPS watch on her right wrist, walks calmly into Lane 1 away from camera. Long diagonal dawn shadows, moody natural contrast.',
        shootDirection: '',
        voLine: "You don't hit the wall when your legs give out.",
        continuityNotes: 'Dawn mist holds through S01–S02.',
        chainFrom: 'none',
        frameImageUrl: null,
        frameCheck: null,
        productFrameApproved: false,
        videoPrompt: '',
        negativePrompt: '',
        videoUrl: null,
        videoSeed: null,
        status: 'Draft',
      },
      {
        id: 'S02',
        deliverable: '30s Hero + 15s Cutdown',
        durationSec: 4,
        scene: 'Close-up on Maya’s left forearm as she presses the Kinetix Core Patch flush onto her skin.',
        route: 'live',
        model: 'none',
        productInFrame: true,
        framePrompt:
          '100mm macro close-up on the outer left forearm of Maya, athletic woman in her late 20s with dark hair tied in a high bun, wearing a matte black technical running singlet, dark split shorts, and a GPS watch on her right wrist. Her right fingertips gently press [PRODUCT PLACEHOLDER: composite real product here] onto her forearm skin on an early dawn stadium track. Soft natural rim light, shallow depth of field.',
        shootDirection:
          'Camera on shoulder rig or tripod with 100mm macro prime at T2.8. Place Maya facing low dawn sun for warm forearm rim light and bounce card below for soft fill. Talent presses hero patch unit cleanly once without covering the faceted aluminum ring.',
        voLine: 'It starts twenty minutes earlier, in drops you never even noticed.',
        continuityNotes: 'Patch sits on upper outer left forearm.',
        chainFrom: 'none',
        frameImageUrl: null,
        frameCheck: null,
        productFrameApproved: false,
        videoPrompt: '',
        negativePrompt: '',
        videoUrl: null,
        videoSeed: null,
        status: 'Draft',
      },
      {
        id: 'S03',
        deliverable: '30s Hero + 15s Cutdown',
        durationSec: 6,
        scene: 'Low tracking shot beside Maya sprinting at tempo speed past concrete stadium bleachers.',
        route: 'hybrid',
        model: 'flux3',
        productInFrame: true,
        framePrompt:
          'Low-angle 35mm tracking medium shot of Maya, athletic woman in her late 20s with dark hair tied in a high bun, wearing a matte black technical running singlet, dark split shorts, and a GPS watch on her right wrist, sprinting down a concrete stadium track with [PRODUCT PLACEHOLDER: composite real product here] visible on her left forearm. Diagonal bleacher shadows strobe softly across frame.',
        shootDirection:
          'Mount camera on silent electric cart tracking parallel in Lane 3 at 14 mph. 35mm lens at T2.8, 1/96 shutter for crisp stride. Keep left forearm clearly readable toward lens.',
        voLine: 'Kinetix reads your sweat sodium and fluid loss in real time.',
        continuityNotes: 'Match stride cadence and sunlight angle from S02.',
        chainFrom: 'none',
        frameImageUrl: null,
        frameCheck: null,
        productFrameApproved: false,
        videoPrompt: '',
        negativePrompt: '',
        videoUrl: null,
        videoSeed: null,
        status: 'Draft',
      },
      {
        id: 'S04',
        deliverable: '30s Hero',
        durationSec: 5,
        scene: 'Maya glances down at a subtle alert on her watch, takes a calm breath, and accelerates into full sunrise.',
        route: 'ai_video',
        model: 'seedance',
        productInFrame: false,
        framePrompt:
          'Medium close-up 85mm profile shot of Maya, athletic woman in her late 20s with dark hair tied in a high bun, wearing a matte black technical running singlet, dark split shorts, and a GPS watch on her right wrist, glancing briefly at her watch mid-stride before looking forward into golden sunrise light on the stadium track. Warm backlight, shallow depth of field.',
        shootDirection: '',
        voLine: 'Know twenty minutes early. Finish strong.',
        continuityNotes: 'Warm sunrise flare closes the spot.',
        chainFrom: 'none',
        frameImageUrl: null,
        frameCheck: null,
        productFrameApproved: false,
        videoPrompt: '',
        negativePrompt: '',
        videoUrl: null,
        videoSeed: null,
        status: 'Draft',
      },
    ],
    shotListHasGenerated: true,
    shotListManuallyEdited: false,
    voScript: [],
    shootPlan: {
      shootDays: [],
      equipment: [],
      propsAndUnits: [],
      crew: [],
      risks: [],
      clientQuestions: [],
      hasGenerated: false,
    },
    approvals: {
      intakeCompleted: true,
      bibleApproved: true,
      briefApproved: true,
      shotListApproved: false,
      storyboardApproved: false,
      videoPromptsApproved: false,
      voApproved: false,
      shootPlanApproved: false,
    },
    generationLog: [
      {
        id: 'log-seed-1',
        timestamp: now,
        step: 'Starter Project',
        model: 'Studio Template',
        prompt: 'Initialized Kinetix Core Patch production pipeline',
        seed: null,
        status: 'success',
      },
    ],
  };

  await saveProject(starterProject);
}

function computeNextStep(proj: PipelineProject): {
  stepNumber: PipelineStepNumber;
  stepLabel: string;
} {
  const a = proj.approvals;
  if (a.shootPlanApproved) return { stepNumber: 9, stepLabel: 'Shoot Plan Ready' };
  if (a.voApproved) return { stepNumber: 9, stepLabel: 'Shoot Plan' };
  if (a.videoPromptsApproved) return { stepNumber: 8, stepLabel: 'VO & Audio' };
  if (a.storyboardApproved) return { stepNumber: 7, stepLabel: 'Video Studio' };
  if (a.shotListApproved) return { stepNumber: 5, stepLabel: 'Storyboard Studio' };
  if (a.briefApproved) return { stepNumber: 4, stepLabel: 'Shot List & Board' };
  if (a.bibleApproved) return { stepNumber: 3, stepLabel: 'Creative Brief' };
  if (a.intakeCompleted) return { stepNumber: 2, stepLabel: 'Brand Bible' };
  return { stepNumber: 1, stepLabel: 'Project Intake' };
}

export function buildProjectSummary(proj: PipelineProject): ProjectSummary {
  const shots = Array.isArray(proj.shots) ? proj.shots : [];
  const photos = Array.isArray(proj.product?.photos) ? proj.product.photos : [];
  const studioAssets = Array.isArray(proj.storyboardStudio?.assets)
    ? proj.storyboardStudio.assets
    : [];
  const voLines = Array.isArray(proj.voScript) ? proj.voScript : [];

  const thumbnailStrip: ProjectThumbnailItem[] = [];
  const seenUrls = new Set<string>();
  const pushThumb = (
    url: string | null | undefined,
    label: string,
    kind: ProjectThumbnailItem['kind']
  ) => {
    if (!url || seenUrls.has(url) || thumbnailStrip.length >= 6) return;
    seenUrls.add(url);
    thumbnailStrip.push({ url, label, kind });
  };

  // Prioritize storyboard frames first so contact sheets show live production visuals
  for (const shot of shots) {
    if (shot.frameImageUrl) {
      pushThumb(shot.frameImageUrl, shot.id, 'frame');
    }
  }
  // Then include Continuity Studio contact/location/prop sheets
  for (const asset of studioAssets) {
    if (asset.imageUrl) {
      pushThumb(asset.imageUrl, asset.name, 'asset');
    }
  }
  // Then include product photos from Step 1 intake
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    pushThumb(p.url, p.caption || `Product ${i + 1}`, 'product');
  }
  // Finally brand logo & brand graphics if slots remain
  if (proj.brandBible?.brandLogoUrl) {
    pushThumb(proj.brandBible.brandLogoUrl, 'Brand Logo', 'logo');
  }
  if (Array.isArray(proj.brandBible?.brandGraphics)) {
    proj.brandBible.brandGraphics.forEach((g, idx) => {
      pushThumb(g.url, g.caption || `Brand Graphic ${idx + 1}`, 'logo');
    });
  }

  const next = computeNextStep(proj);
  const framesReadyCount = shots.filter((s) => Boolean(s.frameImageUrl)).length;
  const videosReadyCount = shots.filter((s) =>
    Boolean(s.upscaledVideoUrl || s.videoUrl)
  ).length;
  const voReadyCount = voLines.filter((v) => Boolean(v.audioUrl)).length;

  return {
    id: proj.id,
    client: proj.client,
    productName: proj.product?.name || 'Untitled Product',
    updatedAt: proj.updatedAt,
    shotCount: shots.length,
    framesReadyCount,
    videosReadyCount,
    voReadyCount,
    totalVoCount: voLines.length,
    coverImageUrl: thumbnailStrip[0]?.url || null,
    brandLogoUrl:
      proj.brandBible?.brandLogoUrl ||
      proj.brandBible?.brandGraphics?.[0]?.url ||
      null,
    thumbnailStrip,
    paletteHexes: Array.isArray(proj.extractedStyleGuide?.paletteHexes)
      ? proj.extractedStyleGuide.paletteHexes.slice(0, 5)
      : [],
    conceptTitle:
      proj.creativeBrief?.recommendedConcept?.title ||
      proj.product?.description?.slice(0, 90) ||
      '',
    nextStepNumber: next.stepNumber,
    nextStepLabel: next.stepLabel,
    approvals: proj.approvals,
    ownerEmail: proj.ownerEmail,
    visibility: proj.visibility,
    isOwner: proj.isOwner,
  };
}

/** Projects the signed-in user can open, newest first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  await seedInitialProjectIfEmpty();
  const a = currentActor();
  const rows = (
    a.isAdmin
      ? db.prepare('SELECT * FROM pipeline_projects ORDER BY updated_at DESC').all()
      : db
          .prepare(
            `SELECT * FROM pipeline_projects
             WHERE owner_id = ? OR visibility = 'team'
             ORDER BY updated_at DESC`
          )
          .all(a.id)
  ) as ProjectRow[];

  const summaries: ProjectSummary[] = [];
  for (const row of rows) {
    try {
      summaries.push(buildProjectSummary(rowToProject(row, a)));
    } catch {
      // Skip a record whose JSON cannot be read rather than failing the list.
    }
  }
  return summaries;
}

/**
 * The project, or null when it doesn't exist OR the user has no access (the two
 * are deliberately indistinguishable).
 */
export async function getProject(projectId: string): Promise<PipelineProject | null> {
  const a = currentActor();
  const row = getRow(sanitizeId(projectId));
  if (!row || !canRead(row, a)) return null;
  try {
    return rowToProject(row, a);
  } catch {
    return null;
  }
}

export interface SaveProjectOptions {
  /**
   * Reject the save (409) if the stored version differs from `project.version`.
   * Used for edits that come from the browser. Server-side steps that read,
   * call an AI model and save within one request leave this off so a slow AI
   * call is not thrown away because someone else saved meanwhile.
   */
  enforceVersion?: boolean;
}

export async function saveProject(
  project: PipelineProject,
  options: SaveProjectOptions = {}
): Promise<PipelineProject> {
  const a = currentActor();
  const id = sanitizeId(project.id);

  // Fields owned by the database are never taken from the JSON body.
  const {
    version: incomingVersion,
    ownerEmail: _ownerEmail,
    visibility: _visibility,
    isOwner: _isOwner,
    ...rest
  } = project;
  const updatedAtIso = new Date().toISOString();
  const data: PipelineProject = { ...rest, id, updatedAt: updatedAtIso } as PipelineProject;
  const payload = JSON.stringify(data);
  const now = Date.now();

  db.transaction(() => {
    const row = getRow(id);
    if (row) {
      if (!canWrite(row, a)) {
        throw new ProjectAccessError(403, 'You do not have access to this project.');
      }
      if (
        options.enforceVersion &&
        typeof incomingVersion === 'number' &&
        incomingVersion !== row.version
      ) {
        throw new ProjectConflictError(row.version);
      }
      db.prepare(
        `UPDATE pipeline_projects
            SET data = ?, client = ?, product_name = ?, version = version + 1, updated_at = ?
          WHERE id = ?`
      ).run(payload, data.client ?? null, data.product?.name ?? null, now, id);
    } else {
      db.prepare(
        `INSERT INTO pipeline_projects
           (id, owner_id, owner_email, visibility, version, client, product_name, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      ).run(
        id,
        a.id,
        a.email,
        DEFAULT_PROJECT_VISIBILITY,
        data.client ?? null,
        data.product?.name ?? null,
        payload,
        now,
        now
      );
    }
  })();

  await ensureDir(getProjectAssetsDir(id));
  const saved = await getProject(id);
  if (!saved) throw new Error('Project was saved but could not be read back.');
  return saved;
}

/** Owner or admin only. Removes the record and its files. */
export async function deleteProject(projectId: string): Promise<void> {
  const a = currentActor();
  const id = sanitizeId(projectId);
  const row = getRow(id);
  if (!row) return;
  if (!canDelete(row, a)) {
    throw new ProjectAccessError(403, 'Only the project owner can delete it.');
  }
  db.prepare('DELETE FROM pipeline_projects WHERE id = ?').run(id);
  await fs.rm(getProjectAssetsDir(id), { recursive: true, force: true });
}

export async function exportProjectBackupBundle(projectId: string): Promise<{
  format: '52launch-project-backup';
  version: number;
  exportedAt: string;
  project: PipelineProject;
  embeddedAssets: Record<string, string>;
}> {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error('Project not found.');
  }

  const assetsDir = getProjectAssetsDir(projectId);
  const embeddedAssets: Record<string, string> = {};
  try {
    const files = await fs.readdir(assetsDir);
    for (const file of files) {
      if (!isSupportedAssetFilename(file)) continue;
      const buf = await fs.readFile(path.join(assetsDir, file));
      const mime = getMimeFromFilename(file);
      if (mime === 'application/octet-stream') continue;
      embeddedAssets[file] = `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch {
    // No assets folder yet
  }

  return {
    format: '52launch-project-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    project,
    embeddedAssets,
  };
}

export async function importProjectBackupBundle(bundle: {
  project?: PipelineProject;
  embeddedAssets?: Record<string, string>;
}): Promise<PipelineProject> {
  const incoming = bundle.project ?? (bundle as unknown as PipelineProject);
  if (!incoming || !incoming.client || !incoming.product?.name) {
    throw new Error('This backup file does not contain a valid 52Launch project.');
  }

  let targetId = sanitizeId(incoming.id || `${incoming.product.name}-${Date.now()}`);
  // Restoring a backup over a project you can edit replaces it. If the id
  // belongs to someone else's private project, import as a new project instead
  // of overwriting it.
  const occupied = getRow(targetId);
  if (occupied && !canWrite(occupied, currentActor())) {
    targetId = sanitizeId(`${incoming.product.name}-${Date.now().toString(36)}`);
  }
  const assetsDir = getProjectAssetsDir(targetId);

  const validatedAssets: Array<{ safeName: string; buffer: Buffer }> = [];
  if (bundle.embeddedAssets && typeof bundle.embeddedAssets === 'object') {
    for (const [filename, dataUrl] of Object.entries(bundle.embeddedAssets)) {
      const safeName = path.basename(filename);
      if (safeName !== filename || !isSupportedAssetFilename(safeName)) {
        throw new Error(
          `Backup contains unsupported asset filename "${filename}". Allowed types: image, audio, video, and PDF.`
        );
      }
      const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error(`Backup asset "${safeName}" has an invalid data encoding.`);
      }
      const mime = match[1].toLowerCase().trim();
      if (!MIME_TO_ASSET_EXT[mime]) {
        throw new Error(
          `Backup asset "${safeName}" has unsupported MIME type "${mime}".`
        );
      }
      validatedAssets.push({
        safeName,
        buffer: Buffer.from(match[2], 'base64'),
      });
    }
  }

  await ensureDir(assetsDir);
  for (const item of validatedAssets) {
    await fs.writeFile(path.join(assetsDir, item.safeName), item.buffer);
  }

  // Rewrite any asset URLs to match the imported project's ID
  const rewriteUrl = (url: string | null | undefined): string | null => {
    if (!url) return null;
    const parts = url.split('/assets/');
    if (parts.length === 2) {
      return `/api/projects/${targetId}/assets/${path.basename(parts[1])}`;
    }
    return url;
  };

  const normalized: PipelineProject = {
    ...incoming,
    id: targetId,
    product: {
      ...incoming.product,
      photos: (incoming.product.photos || []).map((p) => ({
        ...p,
        url: rewriteUrl(p.url) || p.url,
      })),
    },
    shots: (incoming.shots || []).map((s) => ({
      ...s,
      frameImageUrl: rewriteUrl(s.frameImageUrl),
      videoUrl: rewriteUrl(s.videoUrl),
      upscaledVideoUrl: rewriteUrl(s.upscaledVideoUrl),
    })),
    externalUpscales: (incoming.externalUpscales || []).map((item) => ({
      ...item,
      sourceUrl: rewriteUrl(item.sourceUrl) || item.sourceUrl,
      upscaledVideoUrl: rewriteUrl(item.upscaledVideoUrl) || item.upscaledVideoUrl,
    })),
    voScript: (incoming.voScript || []).map((v) => ({
      ...v,
      audioUrl: rewriteUrl(v.audioUrl),
    })),
    brandGuideDocuments: Array.isArray(incoming.brandGuideDocuments)
      ? incoming.brandGuideDocuments.map((doc) => ({
          ...doc,
          url: rewriteUrl(doc.url) || doc.url,
        }))
      : incoming.brandGuideDocuments,
    brandBible: incoming.brandBible
      ? {
          ...incoming.brandBible,
          brandLogoUrl: rewriteUrl(incoming.brandBible.brandLogoUrl),
          brandGraphics: Array.isArray(incoming.brandBible.brandGraphics)
            ? incoming.brandBible.brandGraphics.map((g) => ({
                ...g,
                url: rewriteUrl(g.url) || g.url,
              }))
            : incoming.brandBible.brandGraphics,
        }
      : incoming.brandBible,
    updatedAt: new Date().toISOString(),
  };

  return saveProject(normalized);
}

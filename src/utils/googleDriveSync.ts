import { BrandGuideDocument, ExtractedStyleGuide } from '../types/pipeline';
import { parseJsonResponse } from './safeFetch';

/**
 * Google Drive connection.
 *
 * The browser gets a short-lived Drive access token from Google Identity
 * Services, using the SAME OAuth client the app signs in with (no Firebase). The
 * token is kept in memory only (never localStorage/sessionStorage), is sent to
 * our server in the X-Google-Drive-Token header for each Drive call, and expires
 * after about an hour, after which the user reconnects.
 *
 * Scope: full `drive`. The narrower `drive.file` only covers files the app
 * itself created, so it can't save a PDF into an existing Shared Drive folder
 * someone picked. The OAuth consent screen should be set to Internal, which
 * limits access to the workspace and needs no Google verification.
 */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

export interface DriveUser {
  email: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}

// ---- minimal typing for the Google Identity Services script ----------------
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
  scope?: string;
}
interface GisTokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}
interface GisOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    hd?: string;
    login_hint?: string;
    prompt?: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }) => GisTokenClient;
  hasGrantedAllScopes: (resp: GisTokenResponse, ...scopes: string[]) => boolean;
  revoke: (token: string, done?: () => void) => void;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GisOAuth2 } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisLoad: Promise<GisOAuth2> | null = null;

function loadGis(): Promise<GisOAuth2> {
  const ready = window.google?.accounts?.oauth2;
  if (ready) return Promise.resolve(ready);
  if (gisLoad) return gisLoad;
  gisLoad = new Promise<GisOAuth2>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else {
        gisLoad = null;
        reject(new Error('Google sign-in did not load. Reload the page and try again.'));
      }
    };
    script.onerror = () => {
      gisLoad = null;
      reject(
        new Error(
          'Could not load Google sign-in. Check your connection, or an ad blocker blocking accounts.google.com.'
        )
      );
    };
    document.head.appendChild(script);
  });
  return gisLoad;
}

interface DriveConfig {
  clientId: string;
  domain: string;
  email: string;
}
let configLoad: Promise<DriveConfig> | null = null;

/** Public OAuth settings from our server (needs the app login). */
function loadDriveConfig(): Promise<DriveConfig> {
  if (configLoad) return configLoad;
  configLoad = (async () => {
    const res = await fetch('/api/drive-config', { credentials: 'include' });
    if (res.status === 401) {
      throw new Error('Your session expired. Reload the page and sign in again.');
    }
    const data = (await res.json().catch(() => null)) as Partial<DriveConfig> | null;
    if (!res.ok || !data?.clientId) {
      throw new Error(
        'Google Drive is not set up on this server (missing Google OAuth client). Ask an admin.'
      );
    }
    return { clientId: data.clientId, domain: data.domain ?? '', email: data.email ?? '' };
  })().catch((err) => {
    configLoad = null;
    throw err;
  });
  return configLoad;
}

// ---- in-memory connection state ---------------------------------------------
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0;
let cachedUser: DriveUser | null = null;
let authSuccessCallback: ((user: DriveUser, token: string) => void) | null = null;
let authFailureCallback: (() => void) | null = null;

function tokenIsLive(): boolean {
  // Treat a token as expired 30s early so a request never starts with one about to lapse.
  return Boolean(cachedAccessToken) && Date.now() < cachedExpiresAt - 30_000;
}

function dropExpiredToken(): void {
  if (cachedAccessToken && !tokenIsLive()) {
    cachedAccessToken = null;
    cachedExpiresAt = 0;
  }
}

/**
 * Registers callbacks for the connection state. Fires once straight away:
 * success when a live token is held, otherwise failure ("not connected").
 * Returns an unsubscribe function.
 */
export function initDriveAuth(
  onAuthSuccess?: (user: DriveUser, token: string) => void,
  onAuthFailure?: () => void
): () => void {
  authSuccessCallback = onAuthSuccess || null;
  authFailureCallback = onAuthFailure || null;
  let active = true;
  queueMicrotask(() => {
    if (!active) return;
    dropExpiredToken();
    if (tokenIsLive() && cachedUser && cachedAccessToken) {
      onAuthSuccess?.(cachedUser, cachedAccessToken);
    } else {
      onAuthFailure?.();
    }
  });
  return () => {
    active = false;
    if (authSuccessCallback === onAuthSuccess) authSuccessCallback = null;
    if (authFailureCallback === onAuthFailure) authFailureCallback = null;
  };
}

export async function getGoogleDriveAccessToken(): Promise<string | null> {
  dropExpiredToken();
  return cachedAccessToken;
}

export function getGoogleDriveUser(): DriveUser | null {
  dropExpiredToken();
  return cachedAccessToken ? cachedUser : null;
}

export function clearGoogleDriveToken(): void {
  cachedAccessToken = null;
  cachedExpiresAt = 0;
  cachedUser = null;
}

export function setCachedGoogleDriveAccessToken(token: string | null): void {
  cachedAccessToken = token;
  // Callers that inject a token don't know its lifetime; assume the usual hour.
  cachedExpiresAt = token ? Date.now() + 55 * 60_000 : 0;
}

/** Who owns the token, from Drive itself. Also proves the token works. */
async function fetchDriveUser(token: string): Promise<DriveUser> {
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink)',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'Google Drive access was not granted. Click Connect again and allow access to Google Drive.'
        : `Google Drive did not accept the sign-in (HTTP ${res.status}). Try again.`
    );
  }
  const data = (await res.json()) as {
    user?: { emailAddress?: string; displayName?: string; photoLink?: string };
  };
  return {
    email: data.user?.emailAddress || null,
    displayName: data.user?.displayName || null,
    photoURL: data.user?.photoLink || null,
  };
}

/**
 * Opens Google's consent popup and stores the resulting Drive token. Must be
 * called from a click: browsers block popups opened after other awaits.
 * `forceConsent` re-shows the permission screen (use it when scopes are missing).
 */
export async function signInWithGoogleDrive(forceConsent = false): Promise<{
  user: DriveUser;
  accessToken: string;
}> {
  isSigningIn = true;
  try {
    const [oauth2, config] = await Promise.all([loadGis(), loadDriveConfig()]);

    const resp = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: config.clientId,
        scope: DRIVE_SCOPES.join(' '),
        // Hints only. The account is verified below.
        hd: config.domain || undefined,
        login_hint: config.email || undefined,
        callback: (r) => {
          if (r.error) {
            reject(
              new Error(
                r.error === 'access_denied'
                  ? 'Google Drive access was declined. Click Connect again and allow access.'
                  : r.error_description || `Google sign-in failed (${r.error}).`
              )
            );
          } else {
            resolve(r);
          }
        },
        error_callback: (err) => {
          reject(
            new Error(
              err.type === 'popup_closed'
                ? 'The Google sign-in window was closed before finishing.'
                : err.type === 'popup_failed_to_open'
                  ? 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.'
                  : err.message || 'Google sign-in failed.'
            )
          );
        },
      });
      client.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
    });

    const accessToken = resp.access_token;
    if (!accessToken) throw new Error('Failed to get a Google Drive access token from sign-in.');

    if (!oauth2.hasGrantedAllScopes(resp, ...DRIVE_SCOPES)) {
      oauth2.revoke(accessToken);
      throw new Error(
        'Google Drive permission was not fully granted. Click Connect again and allow access to Google Drive.'
      );
    }

    const user = await fetchDriveUser(accessToken);
    // A personal Google account must never be used for company Drive writes.
    if (
      config.domain &&
      !(user.email ?? '').toLowerCase().endsWith(`@${config.domain.toLowerCase()}`)
    ) {
      oauth2.revoke(accessToken);
      throw new Error(
        `Connect a @${config.domain} Google account. ${user.email ?? 'That account'} can't be used for company Drive folders.`
      );
    }

    cachedAccessToken = accessToken;
    cachedExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    cachedUser = user;
    authSuccessCallback?.(user, accessToken);
    return { user, accessToken };
  } finally {
    isSigningIn = false;
  }
}

/** True while the consent popup is open. */
export function isDriveSigningIn(): boolean {
  return isSigningIn;
}

export async function logoutGoogleDrive(): Promise<void> {
  const token = cachedAccessToken;
  clearGoogleDriveToken();
  if (token) {
    // Best effort: also revoke the token at Google so it can't be reused.
    try {
      (await loadGis()).revoke(token);
    } catch {
      // ignore: the local token is already dropped
    }
  }
  authFailureCallback?.();
}
export function extractDriveFolderId(urlOrId?: string): string | null {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('/') && /^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch && queryMatch[1]) return queryMatch[1];
  return null;
}

export function extractDriveFileId(urlOrId?: string): string | null {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;
  if (/\/folders\//.test(trimmed)) return null;
  if (!trimmed.includes('/') && /^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return trimmed;
  }
  const fileMatch = trimmed.match(
    /\/(?:file|document|spreadsheets|presentation|drawings)\/d\/([a-zA-Z0-9_-]+)/
  );
  if (fileMatch && fileMatch[1]) return fileMatch[1];
  const openMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch && openMatch[1]) return openMatch[1];
  return null;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  thumbnailLink?: string;
  iconLink?: string;
  folderUrl?: string;
  folderPath?: string;
  size?: string;
  modifiedTime?: string;
}

interface RawDriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  thumbnailLink?: string;
  iconLink?: string;
  size?: string;
  modifiedTime?: string;
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
  };
}

async function fetchFolderChildren(
  folderId: string,
  accessToken: string
): Promise<RawDriveFile[]> {
  const query = `'${folderId}' in parents and trashed = false`;
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}` +
    `&fields=files(id,name,mimeType,webViewLink,thumbnailLink,iconLink,size,modifiedTime,shortcutDetails(targetId,targetMimeType))` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('Google Drive session expired. Please sign in with Google again.');
  }

  if (!res.ok) {
    let apiMessage = `Google Drive returned HTTP ${res.status}.`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) {
        apiMessage = errJson.error.message;
      }
    } catch {
      // ignore
    }
    throw new Error(`Could not access Google Drive folder (${folderId}): ${apiMessage}`);
  }

  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}

export async function listGoogleDriveFolderFiles(
  folderUrls: string[],
  accessToken: string
): Promise<DriveFileItem[]> {
  if (!accessToken) {
    throw new Error('Please sign in with Google first to read your Drive folders.');
  }

  const allFiles: DriveFileItem[] = [];
  const seenIds = new Set<string>();

  for (const rawUrl of folderUrls) {
    const url = rawUrl.trim();
    if (!url) continue;

    const rootFolderId = extractDriveFolderId(url);
    if (!rootFolderId) {
      throw new Error(
        `Invalid Google Drive folder URL: "${url}". Expected a link containing /folders/<ID>.`
      );
    }

    const queue: Array<{ id: string; pathPrefix: string; depth: number }> = [
      { id: rootFolderId, pathPrefix: '', depth: 0 },
    ];
    const visitedFolders = new Set<string>([rootFolderId]);

    while (queue.length > 0 && allFiles.length < 150) {
      const current = queue.shift()!;
      const children = await fetchFolderChildren(current.id, accessToken);

      for (const child of children) {
        let resolvedId = child.id;
        let resolvedMime = child.mimeType;

        if (
          child.mimeType === 'application/vnd.google-apps.shortcut' &&
          child.shortcutDetails?.targetId
        ) {
          resolvedId = child.shortcutDetails.targetId;
          if (child.shortcutDetails.targetMimeType) {
            resolvedMime = child.shortcutDetails.targetMimeType;
          }
        }

        if (resolvedMime === 'application/vnd.google-apps.folder') {
          if (current.depth < 3 && !visitedFolders.has(resolvedId)) {
            visitedFolders.add(resolvedId);
            queue.push({
              id: resolvedId,
              pathPrefix: current.pathPrefix
                ? `${current.pathPrefix} / ${child.name}`
                : child.name,
              depth: current.depth + 1,
            });
          }
          continue;
        }

        if (!seenIds.has(resolvedId)) {
          seenIds.add(resolvedId);
          allFiles.push({
            id: resolvedId,
            name: child.name,
            mimeType: resolvedMime,
            webViewLink: child.webViewLink,
            thumbnailLink: child.thumbnailLink,
            iconLink: child.iconLink,
            size: child.size,
            modifiedTime: child.modifiedTime,
            folderUrl: url,
            folderPath: current.pathPrefix || undefined,
          });
        }
      }
    }
  }

  return allFiles;
}

export async function getDriveFileMetadata(
  fileId: string,
  accessToken: string
): Promise<DriveFileItem> {
  if (!accessToken) {
    throw new Error('Please sign in with Google first.');
  }
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?fields=id,name,mimeType,webViewLink,thumbnailLink,iconLink,size,modifiedTime,shortcutDetails(targetId,targetMimeType)` +
    `&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('Google Drive session expired. Please sign in with Google again.');
  }
  if (!res.ok) {
    let apiMessage = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error?.message) apiMessage = err.error.message;
    } catch {
      // ignore
    }
    throw new Error(`Could not load Google Drive file (${fileId}): ${apiMessage}`);
  }
  const f = (await res.json()) as RawDriveFile;
  return {
    id: f.shortcutDetails?.targetId || f.id,
    name: f.name,
    mimeType: f.shortcutDetails?.targetMimeType || f.mimeType,
    webViewLink: f.webViewLink,
    thumbnailLink: f.thumbnailLink,
    iconLink: f.iconLink,
    size: f.size,
    modifiedTime: f.modifiedTime,
  };
}

export interface DriveExplorerItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  webViewLink?: string;
  thumbnailLink?: string;
  iconLink?: string;
  size?: string;
  modifiedTime?: string;
}

export interface SharedDriveItem {
  id: string;
  name: string;
}

export async function listSharedDrives(accessToken: string): Promise<SharedDriveItem[]> {
  if (!accessToken) return [];
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/drives?pageSize=50', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.drives)
      ? data.drives.map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))
      : [];
  } catch {
    return [];
  }
}

export async function listDriveExplorerItems(params: {
  accessToken: string;
  folderId?: string;
  sharedWithMe?: boolean;
  sharedDriveId?: string;
  searchQuery?: string;
}): Promise<DriveExplorerItem[]> {
  const { accessToken, folderId, sharedWithMe, sharedDriveId, searchQuery } = params;
  if (!accessToken) {
    throw new Error('Please sign in with Google first.');
  }

  let query = 'trashed = false';
  const cleanSearch = (searchQuery || '').trim().replace(/'/g, "\\'");

  if (cleanSearch) {
    query += ` and name contains '${cleanSearch}'`;
  } else if (sharedWithMe) {
    query += ' and sharedWithMe = true';
  } else if (sharedDriveId) {
    const target = folderId || sharedDriveId;
    query += ` and '${target}' in parents`;
  } else {
    const target = folderId && folderId !== 'root' ? folderId : 'root';
    query += ` and '${target}' in parents`;
  }

  let url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}` +
    `&fields=files(id,name,mimeType,webViewLink,thumbnailLink,iconLink,size,modifiedTime,shortcutDetails(targetId,targetMimeType))` +
    `&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true` +
    `&orderBy=folder,name_natural,modifiedTime desc`;

  if (sharedDriveId && !cleanSearch) {
    url += `&corpora=drive&driveId=${encodeURIComponent(sharedDriveId)}`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('Google Drive session expired. Please sign in with Google again.');
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch {}
    throw new Error(`Could not browse Google Drive: ${msg}`);
  }

  const data = await res.json();
  const rawFiles: RawDriveFile[] = Array.isArray(data.files) ? data.files : [];

  return rawFiles.map((f) => {
    let targetId = f.id;
    let targetMime = f.mimeType;
    if (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails) {
      if (f.shortcutDetails.targetId) targetId = f.shortcutDetails.targetId;
      if (f.shortcutDetails.targetMimeType) targetMime = f.shortcutDetails.targetMimeType;
    }
    const isFolder = targetMime === 'application/vnd.google-apps.folder';
    return {
      id: targetId,
      name: f.name,
      mimeType: targetMime,
      isFolder,
      webViewLink: f.webViewLink,
      thumbnailLink: f.thumbnailLink,
      iconLink: f.iconLink,
      size: f.size,
      modifiedTime: f.modifiedTime,
    };
  });
}

export async function createDriveFolderOnDrive(params: {
  accessToken: string;
  name: string;
  parentFolderId?: string;
}): Promise<{ id: string; name: string; webViewLink?: string }> {
  const { accessToken, name, parentFolderId } = params;
  if (!accessToken) throw new Error('Sign in with Google required.');
  const metadata: Record<string, unknown> = {
    name: name.trim(),
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentFolderId && parentFolderId !== 'root') {
    metadata.parents = [parentFolderId];
  }
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch {}
    throw new Error(`Could not create Drive folder: ${msg}`);
  }
  return res.json();
}

export async function getDriveFolderDetails(
  folderId: string,
  accessToken: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  if (!accessToken) throw new Error('Sign in with Google required.');
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,webViewLink,mimeType&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch {}
    throw new Error(`Could not fetch Drive folder info: ${msg}`);
  }
  return res.json();
}

export async function syncProjectToDriveServer(
  projectId: string,
  googleDriveFolderUrls: string[],
  accessToken?: string | null,
  destinationFolderId?: string,
  destinationFolderUrl?: string
): Promise<{
  success: boolean;
  syncedAt: string;
  backupFolderUrl?: string;
  backupFolderId?: string;
  uploadedFiles?: string[];
  warning?: string;
}> {
  const token = accessToken ?? cachedAccessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['X-Google-Drive-Token'] = token;
  }

  const resp = await fetch('/api/pipeline/drive-sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectId,
      googleDriveFolderUrls,
      destinationFolderId,
      destinationFolderUrl,
    }),
  });
  if (resp.status === 401) {
    cachedAccessToken = null;
  }
  const data = await parseJsonResponse<{
    syncedAt?: string;
    backupFolderUrl?: string;
    backupFolderId?: string;
    uploadedFiles?: string[];
    warning?: string;
    error?: string;
  }>(resp, 'Drive sync failed.');
  return {
    success: true,
    syncedAt: data.syncedAt || new Date().toISOString(),
    backupFolderUrl: data.backupFolderUrl,
    backupFolderId: data.backupFolderId,
    uploadedFiles: data.uploadedFiles,
    warning: data.warning,
  };
}

export async function uploadPdfToDriveServer(params: {
  projectId: string;
  filename: string;
  pdfBlob: Blob;
  destinationFolderId?: string;
  destinationFolderUrl?: string;
  accessToken?: string | null;
}): Promise<{
  success: boolean;
  backupFolderId?: string;
  backupFolderUrl?: string;
  filename?: string;
}> {
  const token = params.accessToken ?? cachedAccessToken;
  if (!token) {
    throw new Error('Sign in with Google Drive first to auto-save PDFs.');
  }

  let pdfBase64: string;
  if (typeof FileReader !== 'undefined') {
    pdfBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not encode PDF for Drive upload.'));
      reader.readAsDataURL(params.pdfBlob);
    });
  } else if (typeof params.pdfBlob.arrayBuffer === 'function') {
    const arrayBuffer = await params.pdfBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(arrayBuffer).toString('base64');
    pdfBase64 = `data:application/pdf;base64,${b64}`;
  } else {
    throw new Error('Could not encode PDF for Drive upload.');
  }

  const resp = await fetch('/api/pipeline/drive-upload-pdf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Google-Drive-Token': token,
    },
    body: JSON.stringify({
      projectId: params.projectId,
      filename: params.filename,
      pdfBase64,
      destinationFolderId: params.destinationFolderId,
      destinationFolderUrl: params.destinationFolderUrl,
    }),
  });
  if (resp.status === 401) {
    cachedAccessToken = null;
  }

  return parseJsonResponse<{
    success: boolean;
    backupFolderId?: string;
    backupFolderUrl?: string;
    filename?: string;
  }>(resp, 'Could not upload PDF to Google Drive.');
}

export type LlmRoutingMode = 'auto' | 'fal_gemini' | 'google_direct';

export interface LlmRoutingStatus {
  mode: LlmRoutingMode;
  geminiConfigured: boolean;
  falConfigured: boolean;
  geminiTextModel: string;
  falGeminiModel: string;
}

export async function getLlmRoutingStatus(): Promise<LlmRoutingStatus> {
  const resp = await fetch('/api/pipeline/llm-status');
  return parseJsonResponse<LlmRoutingStatus>(resp, 'Could not fetch AI routing status.');
}

export async function setLlmRoutingMode(mode: LlmRoutingMode): Promise<LlmRoutingStatus> {
  const resp = await fetch('/api/pipeline/llm-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  return parseJsonResponse<LlmRoutingStatus>(resp, 'Could not switch AI engine mode.');
}

export interface ParsedDriveIntakeResult {
  parsed: {
    client: string;
    productName: string;
    productDescription: string;
    provableClaims: string[];
    audience: string;
    tone: string;
    clientMarketingIdeas: string;
    videosWanted: string;
    shootLocationDatesBudgetNotes: string;
  };
  styleGuide?: ExtractedStyleGuide;
  brandGuideDocuments?: BrandGuideDocument[];
  stagedGuidePdfs?: Array<{ name: string; dataUrl: string; graphicCount?: number }>;
  suggestedLogoUrl?: string;
  suggestedLogoDataUrl?: string;
  importedBrandGraphics?: Array<{ id: string; url: string; caption: string }>;
  importedBrandGraphicsDataUrls?: Array<{ dataUrl: string; caption: string }>;
  extractedGraphicCount?: number;
  analyzedFiles: Array<{ name: string; status: string }>;
  importedPhotos?: Array<{ id: string; url: string; caption: string }>;
  importedPhotoDataUrls?: Array<{ dataUrl: string; caption: string }>;
  warnings?: string[];
}

export async function parseLocalStyleGuidePdfs(
  projectId: string,
  files: Array<{ name: string; dataUrl: string }>
): Promise<ParsedDriveIntakeResult> {
  const resp = await fetch('/api/pipeline/parse-local-guides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, files }),
  });
  return parseJsonResponse<ParsedDriveIntakeResult>(
    resp,
    'Could not parse PDF style guide.'
  );
}

export async function parseGoogleDriveFolder(
  projectId: string,
  googleDriveFolderUrls: string[],
  filesToAnalyze: DriveFileItem[],
  accessToken: string
): Promise<ParsedDriveIntakeResult> {
  if (!accessToken) {
    throw new Error('Please sign in with Google first so the studio can read your Drive files.');
  }

  const resp = await fetch('/api/pipeline/drive-parse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Google-Drive-Token': accessToken,
    },
    body: JSON.stringify({
      projectId,
      googleDriveFolderUrls,
      filesToAnalyze,
    }),
  });
  if (resp.status === 401) {
    cachedAccessToken = null;
  }
  return parseJsonResponse<ParsedDriveIntakeResult>(resp, 'Drive parse failed.');
}

export interface ImportedDriveAsset {
  fileId: string;
  name: string;
  mimeType: string;
  url?: string;
  filename?: string;
  falUrl?: string | null;
  dataUrl?: string;
}

export async function importDriveFilesToProject(params: {
  projectId: string;
  files: DriveFileItem[];
  prefix?: string;
  uploadToFal?: boolean;
  accessToken: string;
}): Promise<{
  assets: ImportedDriveAsset[];
  warnings: string[];
}> {
  if (!params.accessToken) {
    throw new Error('Please sign in with Google first to import Drive assets.');
  }

  const resp = await fetch('/api/pipeline/drive-import-assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Google-Drive-Token': params.accessToken,
    },
    body: JSON.stringify({
      projectId: params.projectId,
      files: params.files,
      prefix: params.prefix,
      uploadToFal: Boolean(params.uploadToFal),
    }),
  });
  if (resp.status === 401) {
    cachedAccessToken = null;
  }
  const data = await parseJsonResponse<{
    assets?: ImportedDriveAsset[];
    warnings?: string[];
  }>(resp, 'Could not import selected Drive files.');
  return {
    assets: Array.isArray(data.assets) ? data.assets : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  };
}

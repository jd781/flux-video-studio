import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * SQLite persistence for users and generation usage.
 *
 * The DB file lives at DATA_DIR/app.db. On Fly.io, point DATA_DIR at a mounted
 * volume (e.g. /data) so records survive restarts. Locally it defaults to
 * ./data which is gitignored.
 */
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'app.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,      -- Google 'sub' (stable user id)
    email       TEXT UNIQUE NOT NULL,
    name        TEXT,
    picture     TEXT,
    created_at  INTEGER NOT NULL,
    last_login  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generations (
    id            TEXT PRIMARY KEY,     -- our internal id
    user_id       TEXT NOT NULL,
    user_email    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    kind          TEXT NOT NULL,        -- 'generate' | 'upscale'
    model_id      TEXT,                 -- e.g. seedance-2.5
    endpoint      TEXT,                 -- fal endpoint id used
    request_id    TEXT,                 -- fal request id
    resolution    TEXT,
    duration      INTEGER,
    aspect_ratio  TEXT,
    tokens        INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    status        TEXT NOT NULL,        -- 'completed' | 'failed'
    error         TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id);
  CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    owner_email     TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    folder          TEXT,
    params          TEXT NOT NULL,        -- JSON FluxGenerationParams
    takes           TEXT NOT NULL,        -- JSON VideoTake[]
    current_take_id TEXT,
    thumbnail_url   TEXT,
    visibility      TEXT NOT NULL DEFAULT 'private', -- 'private' | 'team' | 'shared'
    is_starred      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_visibility ON sessions(visibility);

  CREATE TABLE IF NOT EXISTS session_shares (
    session_id        TEXT NOT NULL,
    shared_with_email TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (session_id, shared_with_email),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_shares_email ON session_shares(shared_with_email);
`);

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  created_at: number;
  last_login: number;
}

export interface GenerationRow {
  id: string;
  user_id: string;
  user_email: string;
  created_at: number;
  kind: string;
  model_id: string | null;
  endpoint: string | null;
  request_id: string | null;
  resolution: string | null;
  duration: number | null;
  aspect_ratio: string | null;
  tokens: number;
  cost_usd: number;
  status: string;
  error: string | null;
}

/** Insert or update a user on login. */
export function upsertUser(u: {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, name, picture, created_at, last_login)
     VALUES (@id, @email, @name, @picture, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       picture = excluded.picture,
       last_login = excluded.last_login`
  ).run({
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    picture: u.picture ?? null,
    now,
  });
}

/** Record a generation/upscale usage row. */
export function recordGeneration(row: Omit<GenerationRow, 'created_at'> & {
  created_at?: number;
}): void {
  db.prepare(
    `INSERT INTO generations
       (id, user_id, user_email, created_at, kind, model_id, endpoint,
        request_id, resolution, duration, aspect_ratio, tokens, cost_usd,
        status, error)
     VALUES
       (@id, @user_id, @user_email, @created_at, @kind, @model_id, @endpoint,
        @request_id, @resolution, @duration, @aspect_ratio, @tokens, @cost_usd,
        @status, @error)`
  ).run({
    ...row,
    created_at: row.created_at ?? Date.now(),
  });
}

/** All generations for one user, newest first. */
export function getUserGenerations(userId: string, limit = 500): GenerationRow[] {
  return db
    .prepare(
      `SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit) as GenerationRow[];
}

/** Per-user aggregate totals (for the current user's "my usage"). */
export function getUserTotals(userId: string): {
  count: number;
  tokens: number;
  cost_usd: number;
} {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM generations WHERE user_id = ? AND status = 'completed'`
    )
    .get(userId) as { count: number; tokens: number; cost_usd: number };
  return r;
}

/** Admin view: per-user totals across everyone. */
export function getAllUserTotals(): Array<{
  user_id: string;
  email: string;
  name: string | null;
  count: number;
  tokens: number;
  cost_usd: number;
  last_generation: number | null;
}> {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.name,
              COUNT(g.id) AS count,
              COALESCE(SUM(g.tokens), 0) AS tokens,
              COALESCE(SUM(g.cost_usd), 0) AS cost_usd,
              MAX(g.created_at) AS last_generation
       FROM users u
       LEFT JOIN generations g
         ON g.user_id = u.id AND g.status = 'completed'
       GROUP BY u.id
       ORDER BY cost_usd DESC`
    )
    .all() as Array<{
    user_id: string;
    email: string;
    name: string | null;
    count: number;
    tokens: number;
    cost_usd: number;
    last_generation: number | null;
  }>;
}

/** Admin view: recent generations across everyone. */
export function getRecentGenerations(limit = 200): GenerationRow[] {
  return db
    .prepare(`SELECT * FROM generations ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as GenerationRow[];
}

/** Grand totals across all completed generations. */
export function getGrandTotals(): {
  count: number;
  tokens: number;
  cost_usd: number;
} {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM generations WHERE status = 'completed'`
    )
    .get() as { count: number; tokens: number; cost_usd: number };
  return r;
}

// ---------------------------------------------------------------------------
// Sessions (studios)
// ---------------------------------------------------------------------------

export type SessionVisibility = 'private' | 'team' | 'shared';

export interface SessionRow {
  id: string;
  owner_id: string;
  owner_email: string;
  title: string;
  description: string | null;
  folder: string | null;
  params: string; // JSON
  takes: string; // JSON
  current_take_id: string | null;
  thumbnail_url: string | null;
  visibility: SessionVisibility;
  is_starred: number;
  created_at: number;
  updated_at: number;
}

/** Shape sent to / received from the client (parsed JSON + share list + role). */
export interface SessionDTO {
  id: string;
  ownerId: string;
  ownerEmail: string;
  title: string;
  description?: string;
  folder?: string;
  params: unknown;
  takes: unknown;
  currentTakeId: string | null;
  thumbnailUrl?: string;
  visibility: SessionVisibility;
  isStarred: boolean;
  createdAt: number;
  updatedAt: number;
  sharedWith: string[]; // emails (empty unless visibility === 'shared')
  isOwner: boolean; // relative to the requesting user
}

function rowToDTO(row: SessionRow, requesterEmail: string): SessionDTO {
  const sharedWith =
    row.visibility === 'shared' ? getSessionShares(row.id) : [];
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
    title: row.title,
    description: row.description ?? undefined,
    folder: row.folder ?? undefined,
    params: JSON.parse(row.params),
    takes: JSON.parse(row.takes),
    currentTakeId: row.current_take_id,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    visibility: row.visibility,
    isStarred: row.is_starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sharedWith,
    isOwner: row.owner_email.toLowerCase() === requesterEmail.toLowerCase(),
  };
}

export function getSessionShares(sessionId: string): string[] {
  return (
    db
      .prepare(
        `SELECT shared_with_email FROM session_shares WHERE session_id = ?`
      )
      .all(sessionId) as Array<{ shared_with_email: string }>
  ).map((r) => r.shared_with_email);
}

/** Replace the full share list for a session. */
export function setSessionShares(sessionId: string, emails: string[]): void {
  const now = Date.now();
  const tx = db.transaction((list: string[]) => {
    db.prepare(`DELETE FROM session_shares WHERE session_id = ?`).run(sessionId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO session_shares (session_id, shared_with_email, created_at) VALUES (?, ?, ?)`
    );
    for (const email of list) {
      const e = email.trim().toLowerCase();
      if (e) insert.run(sessionId, e, now);
    }
  });
  tx(emails);
}

/** Raw session row by id (no access check). */
export function getSessionRow(id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

/**
 * Whether a user may access (view/edit) a session. Under model B, any user with
 * access can also edit. Admin can access everything.
 */
export function userCanAccessSession(
  row: SessionRow,
  userEmail: string,
  isAdmin: boolean
): boolean {
  const email = userEmail.toLowerCase();
  if (isAdmin) return true;
  if (row.owner_email.toLowerCase() === email) return true;
  if (row.visibility === 'team') return true;
  if (row.visibility === 'shared') {
    return getSessionShares(row.id).includes(email);
  }
  return false;
}

/** Only the owner (or admin) may change sharing/visibility or delete. */
export function userIsOwner(
  row: SessionRow,
  userEmail: string,
  isAdmin: boolean
): boolean {
  return (
    isAdmin || row.owner_email.toLowerCase() === userEmail.toLowerCase()
  );
}

/** List all sessions visible to a user: owned, team, or shared-with-them. */
export function listVisibleSessions(
  userEmail: string,
  isAdmin: boolean
): SessionDTO[] {
  const email = userEmail.toLowerCase();
  let rows: SessionRow[];
  if (isAdmin) {
    rows = db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .all() as SessionRow[];
  } else {
    rows = db
      .prepare(
        `SELECT DISTINCT s.* FROM sessions s
         LEFT JOIN session_shares sh ON sh.session_id = s.id
         WHERE lower(s.owner_email) = ?
            OR s.visibility = 'team'
            OR (s.visibility = 'shared' AND lower(sh.shared_with_email) = ?)
         ORDER BY s.updated_at DESC`
      )
      .all(email, email) as SessionRow[];
  }
  return rows.map((r) => rowToDTO(r, userEmail));
}

export interface UpsertSessionInput {
  id: string;
  ownerId: string;
  ownerEmail: string;
  title: string;
  description?: string;
  folder?: string;
  params: unknown;
  takes: unknown;
  currentTakeId: string | null;
  thumbnailUrl?: string;
  visibility?: SessionVisibility;
  isStarred?: boolean;
}

/** Create a session (owned by the caller). */
export function createSession(input: UpsertSessionInput): SessionRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions
       (id, owner_id, owner_email, title, description, folder, params, takes,
        current_take_id, thumbnail_url, visibility, is_starred, created_at, updated_at)
     VALUES
       (@id, @owner_id, @owner_email, @title, @description, @folder, @params, @takes,
        @current_take_id, @thumbnail_url, @visibility, @is_starred, @now, @now)`
  ).run({
    id: input.id,
    owner_id: input.ownerId,
    owner_email: input.ownerEmail,
    title: input.title,
    description: input.description ?? null,
    folder: input.folder ?? null,
    params: JSON.stringify(input.params),
    takes: JSON.stringify(input.takes ?? []),
    current_take_id: input.currentTakeId ?? null,
    thumbnail_url: input.thumbnailUrl ?? null,
    visibility: input.visibility ?? 'private',
    is_starred: input.isStarred ? 1 : 0,
    now,
  });
  return getSessionRow(input.id)!;
}

/** Update mutable session content (params/takes/title/etc.). Does not touch sharing. */
export function updateSessionContent(
  id: string,
  patch: {
    title?: string;
    description?: string;
    folder?: string;
    params?: unknown;
    takes?: unknown;
    currentTakeId?: string | null;
    thumbnailUrl?: string;
    isStarred?: boolean;
  }
): SessionRow | undefined {
  const existing = getSessionRow(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE sessions SET
       title = @title,
       description = @description,
       folder = @folder,
       params = @params,
       takes = @takes,
       current_take_id = @current_take_id,
       thumbnail_url = @thumbnail_url,
       is_starred = @is_starred,
       updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    title: patch.title ?? existing.title,
    description:
      patch.description !== undefined ? patch.description : existing.description,
    folder: patch.folder !== undefined ? patch.folder : existing.folder,
    params:
      patch.params !== undefined ? JSON.stringify(patch.params) : existing.params,
    takes:
      patch.takes !== undefined ? JSON.stringify(patch.takes) : existing.takes,
    current_take_id:
      patch.currentTakeId !== undefined
        ? patch.currentTakeId
        : existing.current_take_id,
    thumbnail_url:
      patch.thumbnailUrl !== undefined
        ? patch.thumbnailUrl
        : existing.thumbnail_url,
    is_starred:
      patch.isStarred !== undefined
        ? patch.isStarred
          ? 1
          : 0
        : existing.is_starred,
    now: Date.now(),
  });
  return getSessionRow(id);
}

/** Change visibility + shared-with list (owner only — enforced in the route). */
export function setSessionVisibility(
  id: string,
  visibility: SessionVisibility,
  sharedWith: string[]
): SessionRow | undefined {
  const existing = getSessionRow(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE sessions SET visibility = ?, updated_at = ? WHERE id = ?`
  ).run(visibility, Date.now(), id);
  if (visibility === 'shared') {
    setSessionShares(id, sharedWith);
  } else {
    setSessionShares(id, []); // clear explicit shares when not 'shared'
  }
  return getSessionRow(id);
}

export function deleteSession(id: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM session_shares WHERE session_id = ?`).run(id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  });
  tx();
}

export function sessionToDTO(row: SessionRow, requesterEmail: string): SessionDTO {
  return rowToDTO(row, requesterEmail);
}

/** All known team members (for the share dropdown). */
export function listTeamMembers(): Array<{ email: string; name: string | null }> {
  return db
    .prepare(`SELECT email, name FROM users ORDER BY email ASC`)
    .all() as Array<{ email: string; name: string | null }>;
}

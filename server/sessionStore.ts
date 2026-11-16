import session from 'express-session';
import { db } from './db';

/**
 * SQLite-backed express-session store so logins survive restarts/deploys
 * (the default MemoryStore is wiped every time the process restarts).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS http_sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_http_sessions_expires ON http_sessions(expires);
`);

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function expiryOf(sess: session.SessionData): number {
  const exp = sess.cookie?.expires;
  if (exp) return new Date(exp).getTime();
  return Date.now() + DEFAULT_TTL_MS;
}

export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    const purge = () =>
      db.prepare('DELETE FROM http_sessions WHERE expires < ?').run(Date.now());
    purge();
    setInterval(purge, 1000 * 60 * 60).unref();
  }

  get(
    sid: string,
    cb: (err?: unknown, sess?: session.SessionData | null) => void
  ): void {
    try {
      const row = db
        .prepare('SELECT data, expires FROM http_sessions WHERE sid = ?')
        .get(sid) as { data: string; expires: number } | undefined;
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      db.prepare(
        `INSERT INTO http_sessions (sid, data, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`
      ).run(sid, JSON.stringify(sess), expiryOf(sess));
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      db.prepare('UPDATE http_sessions SET expires = ? WHERE sid = ?').run(
        expiryOf(sess),
        sid
      );
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      db.prepare('DELETE FROM http_sessions WHERE sid = ?').run(sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }
}

import type { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import passport from 'passport';
import {
  Strategy as GoogleStrategy,
  type Profile,
} from 'passport-google-oauth20';
import { upsertUser } from './db';

/**
 * Google OAuth authentication, restricted to @52launch.com accounts.
 *
 * Uses a signed cookie session (express-session). The fal proxy and all
 * generation endpoints are gated behind an authenticated session, so an
 * anonymous visitor can neither reach the dashboard nor spend fal credits.
 */

export const ALLOWED_DOMAIN = '52launch.com';
export const ADMIN_EMAIL = 'jd@52launch.com';

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

function isAllowedEmail(email: string | undefined): email is string {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

export function configureAuth(app: Express): void {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    SESSION_SECRET,
    APP_URL,
    NODE_ENV,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn(
      '[auth] WARNING: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Login will fail until configured.'
    );
  }
  if (!SESSION_SECRET) {
    console.warn(
      '[auth] WARNING: SESSION_SECRET not set. Set a long random value in .env.'
    );
  }

  const isProd = NODE_ENV === 'production';
  // Behind Fly's proxy we terminate TLS at the edge; trust it so secure
  // cookies work.
  if (isProd) app.set('trust proxy', 1);

  app.use(
    session({
      name: 'flux.sid',
      secret: SESSION_SECRET || 'dev-insecure-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd, // HTTPS-only in production
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());

  // The callback URL must be registered in the Google OAuth client.
  const base = APP_URL || `http://localhost:${process.env.FAL_PROXY_PORT || 3001}`;
  const callbackURL = `${base.replace(/\/$/, '')}/auth/google/callback`;

  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID || 'missing',
        clientSecret: GOOGLE_CLIENT_SECRET || 'missing',
        callbackURL,
        scope: ['profile', 'email'],
        // Hint Google to restrict the account chooser to the workspace domain.
        // (Not a security control on its own — we still verify below.)
      },
      (
        _accessToken: string,
        _refreshToken: string,
        profile: Profile,
        done: (err: unknown, user?: SessionUser | false) => void
      ) => {
        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!isAllowedEmail(email)) {
          // Reject anyone outside the allowed domain.
          return done(null, false);
        }
        const user: SessionUser = {
          id: profile.id,
          email,
          name: profile.displayName,
          picture: profile.photos?.[0]?.value,
        };
        try {
          upsertUser(user);
        } catch (e) {
          return done(e);
        }
        return done(null, user);
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user as SessionUser);
  });
  passport.deserializeUser((obj: SessionUser, done) => {
    done(null, obj);
  });

  // --- Routes ---
  app.get(
    '/auth/google',
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      // Restrict the Google account picker to the workspace domain.
      hd: ALLOWED_DOMAIN,
      prompt: 'select_account',
    } as Record<string, unknown>)
  );

  app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate(
      'google',
      (err: unknown, user: SessionUser | false) => {
        if (err) return next(err);
        if (!user) {
          // Domain rejected or auth denied.
          return res.redirect('/?auth_error=domain');
        }
        req.logIn(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          return res.redirect('/');
        });
      }
    )(req, res, next);
  });

  app.post('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie('flux.sid');
        res.json({ ok: true });
      });
    });
  });

  // Current session info for the client.
  app.get('/api/me', (req, res) => {
    const user = req.user as SessionUser | undefined;
    if (!user) return res.status(401).json({ authenticated: false });
    res.json({
      authenticated: true,
      user: {
        email: user.email,
        name: user.name,
        picture: user.picture,
        isAdmin: user.email.toLowerCase() === ADMIN_EMAIL,
      },
    });
  });
}

/** Express guard: require an authenticated (allowed-domain) session. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const user = req.user as SessionUser | undefined;
  if (!user || !isAllowedEmail(user.email)) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

/** Express guard: require the single admin account. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const user = req.user as SessionUser | undefined;
  if (!user || user.email.toLowerCase() !== ADMIN_EMAIL) {
    res.status(403).send('Forbidden: admin access only.');
    return;
  }
  next();
}

# Deploying FLUX Video Studio to Fly.io

The app is a single Node/Express service that serves the built React frontend,
proxies fal.ai, and stores users / sessions / usage in SQLite on a Fly volume.

> **Single machine only.** SQLite and the session store live on one machine, so
> the web process must not scale past 1. `fly.toml` is configured for this
> (`min_machines_running = 1`, one volume). Moving beyond one machine requires
> Postgres + a shared session store.

## Prerequisites

1. Install the Fly CLI: https://fly.io/docs/flyctl/install/
2. `fly auth login`
3. You do **not** need Docker locally — Fly builds the image remotely.

## 1. Create the app (don't deploy yet)

```bash
fly launch --no-deploy
```

- When asked, keep the existing `fly.toml` and `Dockerfile`.
- Pick an app name and region. If you choose a name other than
  `flux-video-studio`, update `app = "..."` in `fly.toml`.

Your public URL will be `https://<app-name>.fly.dev`.

## 2. Create the persistent volume

Must match `[mounts].source` in `fly.toml` (`flux_data`) and the app's region:

```bash
fly volumes create flux_data --region iad --size 1
```

## 3. Set secrets

Never commit these — set them as Fly secrets (encrypted, injected as env vars):

```bash
fly secrets set \
  FAL_KEY="your-fal-key" \
  GOOGLE_CLIENT_ID="your-google-client-id" \
  GOOGLE_CLIENT_SECRET="your-google-client-secret" \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  APP_URL="https://<app-name>.fly.dev"
```

`APP_URL` is critical: the server builds the Google OAuth callback from it
(`<APP_URL>/auth/google/callback`).

## 4. Register the production OAuth redirect URI

In Google Cloud Console → your OAuth 2.0 Web client → **Authorized redirect URIs**, add:

```
https://<app-name>.fly.dev/auth/google/callback
```

(Keep the localhost one for local dev.)

## 5. Deploy

```bash
fly deploy
```

Fly builds the Docker image remotely, runs `npm run build`, and starts the
server with `npm run start` on internal port 8080.

## 6. Verify

```bash
fly open                 # opens https://<app-name>.fly.dev
fly logs                 # tail server logs
```

- You should land on the Google login screen.
- Sign in with a `@52launch.com` account → the studio loads.
- Sign in as `jd@52launch.com` → the user menu shows **Admin Dashboard** (`/admin`).
- A non-52launch account is rejected.

## Updating

Just `fly deploy` again. The volume (and all users/sessions/usage) persists
across deploys.

## Notes & gotchas

- **Health checks**: Fly checks the HTTP service on port 8080. `/api/health`
  returns 200 without auth, so the machine is considered healthy.
- **Cookies**: secure, httpOnly session cookies require HTTPS. Fly terminates
  TLS at the edge and the server sets `trust proxy` in production, so this works.
- **Backups**: the SQLite DB is a single file on the volume. For real backups,
  enable Fly volume snapshots or periodically copy `/data/app.db` off-box.
- **Secrets rotation**: changing `SESSION_SECRET` invalidates all active
  sessions (everyone must log in again).

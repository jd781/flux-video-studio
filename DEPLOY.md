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
fly volumes create flux_data --region iad --size 20
```

The volume holds the SQLite database (`app.db`: users, usage, Studio sessions and
Production Pipeline projects) **and** the pipeline's media files under
`/data/assets/<projectId>/`. Images, audio, video and PDFs add up, so start at
20 GB. A volume can be grown later (`fly volumes extend`) but not shrunk.

## 3. Set secrets

Never commit these — set them as Fly secrets (encrypted, injected as env vars):

```bash
fly secrets set \
  FAL_KEY="your-fal-key" \
  GOOGLE_CLIENT_ID="your-google-client-id" \
  GOOGLE_CLIENT_SECRET="your-google-client-secret" \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  GEMINI_API_KEY="your-gemini-key" \
  APP_URL="https://<app-name>.fly.dev"
```

`GEMINI_API_KEY` powers the Production Pipeline's text and vision steps and the
VoxCraft voiceover. Use the company-owned key, and keep it (and `FAL_KEY`) in Fly
secrets only, never in Git or browser code.

`APP_URL` is critical: the server builds the Google OAuth callback from it
(`<APP_URL>/auth/google/callback`).

## 4. Register the production OAuth redirect URI

In Google Cloud Console → your OAuth 2.0 Web client → **Authorized redirect URIs**, add:

```
https://<app-name>.fly.dev/auth/google/callback
```

(Keep the localhost one for local dev.)

### Google Drive (Production Pipeline)

The pipeline's **Connect Google Drive** button uses the **same OAuth client** as
the app login. No Firebase is needed. In the Google Cloud project that owns that
client:

1. **Enable the Google Drive API** (APIs & Services → Library).
2. **OAuth consent screen**: set the user type to **Internal** (only
   `@52launch.com` accounts can connect, and Google does not require app
   verification). Under *Data access / Scopes*, add
   `https://www.googleapis.com/auth/drive`.
3. **Authorized JavaScript origins** on the OAuth client: add
   `https://<app-name>.fly.dev` (and `http://localhost:3001` for local dev). This
   is separate from the redirect URI above and is required for the Drive popup.
4. **Workspace admin**: if API access is restricted for your domain
   (Admin console → Security → API controls), mark this OAuth client as trusted
   so users are not blocked at the consent step.

The app requests the full `drive` scope because the narrower `drive.file` can only
touch files the app created itself, which does not allow saving a PDF into an
existing Shared Drive folder. Connected tokens live in the browser tab's memory,
last about an hour, and the user reconnects after a reload.

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
- **Backups**: data lives in two places on the volume, `/data/app.db` and
  `/data/assets/`. Turn on Fly volume snapshots (they capture both), and also copy
  a consistent database copy plus the assets folder off Fly on a schedule, because
  snapshots are same-provider and short-lived. Test a restore: import a project
  backup (`.52launch-backup`) from the pipeline header, or restore a snapshot to a
  new volume.
- **Concurrent edits**: two people saving the same pipeline project is detected,
  not merged. The second save is refused and the latest copy is shown.
- **Project access**: pipeline projects are visible to every signed-in
  `@52launch.com` user. Only the owner (or `jd@52launch.com`) can delete one.
- **Secrets rotation**: changing `SESSION_SECRET` invalidates all active
  sessions (everyone must log in again).

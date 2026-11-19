import type { FirebaseOptions } from 'firebase/app';

/**
 * Firebase web config used ONLY for the "Connect Google Drive" popup (it yields
 * the Drive access token). App login is separate: it goes through the server's
 * Google OAuth.
 *
 * The values come from build-time env vars (Vite inlines VITE_* at build), so
 * the config of the company-owned Firebase / Google Cloud project is not
 * committed to Git. Set these in `.env` for local builds and as Docker build
 * args for the deployed image:
 *
 *   VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
 *   VITE_FIREBASE_APP_ID  (optional: VITE_FIREBASE_STORAGE_BUCKET,
 *   VITE_FIREBASE_MESSAGING_SENDER_ID)
 *
 * The project must be owned by 52Launch, have Google sign-in enabled, list the
 * app's hostnames under authorized domains, and have the Drive API enabled.
 * (Firebase web API keys are not secrets, but they identify the project, so the
 * project has to be the company's.)
 */
export function getFirebaseConfig(): FirebaseOptions | null {
  const env = import.meta.env;
  const apiKey = env.VITE_FIREBASE_API_KEY as string | undefined;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  const appId = env.VITE_FIREBASE_APP_ID as string | undefined;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  };
}

export const isDriveConfigured = (): boolean => getFirebaseConfig() !== null;

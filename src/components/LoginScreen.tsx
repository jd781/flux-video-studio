import React from 'react';
import { Sparkles, LogIn, AlertCircle } from 'lucide-react';
import { login } from '../lib/auth';

/**
 * Full-screen gate shown when the visitor has no valid @52launch.com session.
 */
export const LoginScreen: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');

  return (
    <div className="min-h-screen bg-[#09090b] text-neutral-100 flex items-center justify-center p-6 antialiased">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-white mb-4">
            <Sparkles className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-semibold">52 Video Studio</h1>
          <p className="text-sm text-neutral-400 mt-1">
            Sign in with your 52launch Google account to continue.
          </p>
        </div>

        {authError === 'domain' && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 text-xs text-orange-200">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              That account isn’t a <strong>@52launch.com</strong> address. Access is
              restricted to 52launch team members.
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={login}
          className="w-full py-2.5 px-5 rounded-xl font-medium text-sm text-neutral-950 bg-white hover:bg-neutral-200 active:scale-[0.99] transition-all flex items-center justify-center gap-2 shadow-sm"
        >
          <LogIn className="w-4 h-4" />
          <span>Sign in with Google</span>
        </button>

        <p className="text-[11px] text-neutral-500 text-center mt-4">
          Only <span className="font-mono text-neutral-400">@52launch.com</span>{' '}
          accounts are permitted.
        </p>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { AppShell } from './AppShell';
import { LoginScreen } from './LoginScreen';
import { AuthUser, fetchMe } from '../lib/auth';
import { Loader2 } from 'lucide-react';

/**
 * Top-level auth gate. Checks the session once on mount:
 *  - loading  -> spinner
 *  - no user  -> LoginScreen
 *  - user     -> the studio (App), with the user passed down
 */
export const AuthGate: React.FC = () => {
  const [status, setStatus] = useState<'loading' | 'in' | 'out'>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let active = true;
    fetchMe().then((u) => {
      if (!active) return;
      if (u) {
        setUser(u);
        setStatus('in');
      } else {
        setStatus('out');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-[#09090b] text-neutral-400 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (status === 'out' || !user) {
    return <LoginScreen />;
  }

  return <AppShell currentUser={user} />;
};

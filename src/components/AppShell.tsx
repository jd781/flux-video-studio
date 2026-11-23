import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import App from '../App';
import type { AuthUser } from '../lib/auth';

// The pipeline pulls in PDF export and audio encoding, so it is only
// downloaded when someone opens it.
const PipelineApp = lazy(() => import('../PipelineApp'));

type Area = 'studio' | 'pipeline';

const areaFromHash = (): Area =>
  window.location.hash.startsWith('#/pipeline') ? 'pipeline' : 'studio';

/**
 * Chooses between the Video Studio and the Production Pipeline. The choice
 * lives in the URL hash (#/studio, #/pipeline) so a link or reload lands on the
 * same area, and the browser Back button works between them.
 */
export const AppShell: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [area, setArea] = useState<Area>(areaFromHash);

  useEffect(() => {
    const onHashChange = () => setArea(areaFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const go = (next: Area) => {
    window.location.hash = next === 'pipeline' ? '#/pipeline' : '#/studio';
  };

  if (area === 'pipeline') {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#F6F6F7] text-[#5A5A66] flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        }
      >
        <PipelineApp currentUser={currentUser} onSwitchToStudio={() => go('studio')} />
      </Suspense>
    );
  }

  return <App currentUser={currentUser} onSwitchToPipeline={() => go('pipeline')} />;
};

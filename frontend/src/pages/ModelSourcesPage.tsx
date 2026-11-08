import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Compass, FolderOpen, Library, Link as LinkIcon } from 'lucide-react';

import { api } from '../api/client';
import { ManyfoldTab } from '../components/ManyfoldTab';
import { ModelsBrowse } from '../components/models/ModelsBrowse';
import { useAuth } from '../contexts/AuthContext';
import { MakerworldPage } from './MakerworldPage';

type SourceTab = 'discover' | 'import' | 'manyfold';

/** One Models destination, with discovery, legacy URL import and Manyfold. */
export function ModelSourcesPage() {
  const { t } = useTranslation();
  const { hasPermission, hasAnyPermission, loading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canViewMakerworld = hasPermission('makerworld:view');
  const canViewLibrary = hasAnyPermission('library:read_own', 'library:read_all', 'library:read');
  const canViewManyfold = hasPermission('manyfold:view');
  const manyfoldStatus = useQuery({
    queryKey: ['manyfold-status'],
    queryFn: () => api.getManyfoldStatus(),
    enabled: !loading && canViewManyfold,
  });
  const showManyfold = canViewManyfold &&
    (manyfoldStatus.data?.configured === true || hasPermission('settings:update'));
  const tabs: { id: SourceTab; label: string; icon: typeof Compass }[] = [];
  if (canViewMakerworld || canViewLibrary) tabs.push({ id: 'discover', label: t('modelsBrowse.discover'), icon: Compass });
  if (canViewMakerworld) tabs.push({ id: 'import', label: t('modelsBrowse.importUrl'), icon: LinkIcon });
  if (showManyfold) tabs.push({ id: 'manyfold', label: t('modelSources.tabManyfold'), icon: Library });
  const requested = searchParams.get('tab');
  // Preserve bookmarks made before discovery replaced the URL-paste landing page.
  const requestedTab = requested === 'makerworld' ? 'import' : requested;
  const active = tabs.find((tab) => tab.id === requestedTab)?.id ?? tabs[0]?.id ??
    (canViewManyfold ? 'manyfold' : undefined);

  if (loading) return <div className="p-8 text-bambu-gray" role="status">{t('modelsBrowse.loading')}</div>;

  return (
    <div className="p-4 md:p-8 max-w-screen-2xl mx-auto">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Compass className="w-7 h-7 text-bambu-green" aria-hidden="true" />
            {t('modelSources.title')}
          </h1>
          <p className="mt-2 text-sm text-bambu-gray">{t('modelsBrowse.intro')}</p>
        </div>
        {canViewLibrary && <Link to="/files" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-bambu-dark-tertiary px-4 text-sm text-white hover:border-bambu-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green">
          <FolderOpen className="h-4 w-4" aria-hidden="true" />{t('modelsBrowse.library')}
        </Link>}
      </header>
      {tabs.length > 1 && (
        <nav className="flex flex-wrap border-b border-bambu-dark-tertiary mb-6" aria-label={t('modelSources.title')}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-current={active === id ? 'page' : undefined}
              onClick={() => setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set('tab', id);
                next.delete('model');
                return next;
              })}
              className={`flex min-h-11 items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green ${active === id ? 'text-bambu-green border-bambu-green' : 'text-bambu-gray hover:text-white border-transparent'}`}>
              <Icon className="w-4 h-4" aria-hidden="true" />{label}
            </button>
          ))}
        </nav>
      )}
      {active === 'discover' && <ModelsBrowse />}
      {active === 'import' && <MakerworldPage embedded />}
      {active === 'manyfold' && <ManyfoldTab />}
      {!active && <p role="alert" className="text-bambu-gray">{t('modelsBrowse.noPermission')}</p>}
    </div>
  );
}

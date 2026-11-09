import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Box, RefreshCw } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import type { ModelProvider } from '../../types/models';

export const controlClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:border-bambu-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

export function ModelImage(props: { provider: ModelProvider; url: string | null; alt: string; className?: string }) {
  // A new source must get a new error state after changing gallery selection.
  return <ImageSource key={props.url} {...props} />;
}
function ImageSource({ provider, url, alt, className }: { provider: ModelProvider; url: string | null; alt: string; className?: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  return url && !failed ? <img src={api.getModelThumbnailUrl(provider, url)} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={className} /> :
    <div className="w-full h-full min-h-24 flex flex-col items-center justify-center gap-2 text-bambu-gray" role={alt ? 'img' : undefined} aria-label={alt || undefined}><Box className="h-8 w-8" aria-hidden="true" /><span className="text-xs">{t('modelsBrowse.noImage')}</span></div>;
}

export function ModelsError({ error, onRetry, compact = false }: { error: unknown; onRetry: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const authError = error instanceof ApiError && (error.status === 401 || error.status === 403);
  return <div role="alert" className={`rounded-lg border border-red-500/30 bg-red-500/5 text-sm ${compact ? 'p-2 mt-2' : 'p-5'}`}>
    <div className="flex items-start gap-2"><AlertCircle className="h-5 w-5 shrink-0 text-red-400" aria-hidden="true" /><div className="min-w-0">
      <p className="font-medium text-white">{t(authError ? 'modelsBrowse.authError' : 'modelsBrowse.loadError')}</p>
      {error instanceof Error && <p className="text-bambu-gray mt-1 break-words">{error.message}</p>}
    </div></div>
    <button type="button" className={`${controlClass} mt-3`} onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden="true" />{t('modelsBrowse.retry')}</button>
  </div>;
}

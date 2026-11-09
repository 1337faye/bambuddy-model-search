import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, ExternalLink, FileBox, Loader2, Save, Scissors } from 'lucide-react';
import { api, type LibraryFolderTree } from '../../api/client';
import type { ModelProvider, PreparedModelFile } from '../../types/models';
import { useAuth } from '../../contexts/AuthContext';
import { SliceModal } from '../SliceModal';
import { controlClass, ModelImage, ModelsError } from './shared';
import { providerName, safeExternalUrl, sanitizeModelDescription } from './modelUtils';
import { profileCompatibility, profilePrinters, prioritizeProfiles } from './profileCompatibility';

function folderOptions(folders: LibraryFolderTree[], parent = ''): { id: number; name: string }[] {
  return folders.flatMap((folder) => {
    const name = parent ? `${parent} / ${folder.name}` : folder.name;
    return [
      ...(folder.can_write && !folder.external_readonly ? [{ id: folder.id, name }] : []),
      ...folderOptions(folder.children ?? [], name),
    ];
  });
}

export function ModelDetailView({ provider, id, onBack }: { provider: ModelProvider; id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const { hasPermission, user } = useAuth();
  const client = useQueryClient();
  const canPrepare = hasPermission('library:upload') && (provider !== 'makerworld' || hasPermission('makerworld:import'));
  const detail = useQuery({
    queryKey: ['models', user?.id, provider, 'detail', id],
    queryFn: ({ signal }) => api.getModelDetail(provider, id, signal),
    staleTime: 60_000, gcTime: 120_000, retry: false,
  });
  const folders = useQuery({ queryKey: ['library-folders'], queryFn: api.getLibraryFolders, enabled: canPrepare, retry: false });
  const printers = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters, enabled: provider === 'makerworld' && hasPermission('printers:read'), retry: false });
  const [targetModel, setTargetModel] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [folderId, setFolderId] = useState<number | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [busy, setBusy] = useState<'save' | 'slice' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [lastAction, setLastAction] = useState<'save' | 'slice'>('save');
  const [saved, setSaved] = useState<PreparedModelFile | null>(null);
  const [sliceSource, setSliceSource] = useState<PreparedModelFile | null>(null);
  const [cleanupError, setCleanupError] = useState<unknown>(null);
  const [cleanupId, setCleanupId] = useState<number | null>(null);
  const mounted = useRef(false);
  const temporary = useRef<number | null>(null);
  const actionLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const temporaryId = temporary.current;
      temporary.current = null;
      // Navigation away also releases owned temporary imports. Saved library
      // files (including existing files) never enter this path.
      if (temporaryId !== null) void api.deleteTemporaryModelFile(temporaryId).catch(() => { /* Server expiry remains the fallback on network loss. */ });
    };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [detail.data?.id]);
  const html = useMemo(() => sanitizeModelDescription(detail.data?.description_html ?? ''), [detail.data?.description_html]);
  const file = detail.data?.files.find((item) => item.id === selectedFile);
  const orderedFiles = prioritizeProfiles(detail.data?.files ?? [], targetModel);
  const printerModels = Array.from(new Set(printers.data?.flatMap((printer) => printer.model ? [printer.model] : []) ?? []));
  const images = Array.from(new Set([...(detail.data?.images ?? []), ...(detail.data?.thumbnail ? [detail.data.thumbnail] : [])]));
  const writableFolders = folderOptions(folders.data ?? []);
  const validFolder = folderId === null || writableFolders.some((folder) => folder.id === folderId);

  const cleanup = async (temporaryId: number) => {
    try {
      await api.deleteTemporaryModelFile(temporaryId);
      if (temporary.current === temporaryId) temporary.current = null;
      if (mounted.current) { setCleanupId(null); setCleanupError(null); }
    } catch (error) {
      if (mounted.current) { setCleanupId(temporaryId); setCleanupError(error); }
    }
  };
  const closeSlice = () => {
    setSliceSource(null);
    const temporaryId = temporary.current;
    if (temporaryId !== null) {
      // SliceModal calls onClose after enqueue returns, or on cancel. The
      // backend has captured source bytes before an enqueue response.
      setCleanupId(temporaryId);
      void cleanup(temporaryId);
    }
  };
  const prepare = async (action: 'save' | 'slice') => {
    if (!file || !canPrepare || actionLock.current || cleanupId !== null || (action === 'slice' && !file.sliceable) || (action === 'save' && !validFolder)) return;
    actionLock.current = true;
    setBusy(action); setLastAction(action); setActionError(null); setSaved(null);
    try {
      const prepared = await api.prepareModelFile(provider, id, { file_id: file.id, action, folder_id: action === 'save' ? folderId : null });
      if (!mounted.current) {
        if (prepared.temporary) void api.deleteTemporaryModelFile(prepared.library_file_id).catch(() => {});
        return;
      }
      if (action === 'slice') {
        temporary.current = prepared.temporary ? prepared.library_file_id : null;
        setSliceSource(prepared);
      } else {
        setSaved(prepared);
        for (const key of ['library-files', 'library-folders', 'library-stats']) void client.invalidateQueries({ queryKey: [key] });
      }
    } catch (error) {
      if (mounted.current) setActionError(error);
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return <div className="space-y-6">
    <button className={controlClass} onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('modelsBrowse.back')}</button>
    {detail.isPending ? <div role="status" className="min-h-64 rounded-xl bg-bambu-dark-secondary flex items-center justify-center gap-2 text-bambu-gray"><Loader2 className="h-5 w-5 motion-safe:animate-spin" />{t('modelsBrowse.loading')}</div> : detail.isError ? <ModelsError error={detail.error} onRetry={() => void detail.refetch()} /> : <>
      <header>
        <p className="text-sm text-bambu-green mb-2">{providerName(provider)}</p>
        <h2 ref={heading} tabIndex={-1} className="text-2xl md:text-3xl font-bold text-white break-words focus:outline-none">{detail.data.title}</h2>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-bambu-gray">
          <span>{t('modelsBrowse.by', { creator: detail.data.creator })}</span>
          {detail.data.license && <span>{t('modelsBrowse.license', { license: detail.data.license })}</span>}
          {safeExternalUrl(detail.data.url) && <a className="inline-flex items-center gap-1 text-bambu-green underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green" href={safeExternalUrl(detail.data.url)} target="_blank" rel="noopener noreferrer">{t('modelsBrowse.original')}<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>}
        </div>
      </header>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-6">
        <div className="min-w-0 space-y-3">
          <div className="aspect-[4/3] rounded-xl overflow-hidden bg-bambu-dark-secondary border border-bambu-dark-tertiary"><ModelImage provider={provider} url={images[imageIndex] ?? images[0] ?? null} alt={detail.data.title} className="w-full h-full object-contain" /></div>
          {images.length > 1 && <div className="flex gap-2 overflow-x-auto pb-2" role="group" aria-label={t('modelsBrowse.gallery')}>
            {images.map((url, index) => <button key={url} onClick={() => setImageIndex(index)} aria-label={t('modelsBrowse.image', { number: index + 1 })} aria-pressed={index === imageIndex} className={`w-20 h-16 shrink-0 overflow-hidden rounded-lg border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green ${index === imageIndex ? 'border-bambu-green' : 'border-transparent'}`}><ModelImage provider={provider} url={url} alt="" className="w-full h-full object-cover" /></button>)}
          </div>}
        </div>
        <section className="min-w-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 md:p-5 space-y-4" aria-labelledby="model-files-heading">
          <div><h3 id="model-files-heading" className="font-semibold text-lg text-white">{t('modelsBrowse.files')}</h3><p className="text-sm text-bambu-gray mt-1">{t('modelsBrowse.chooseFile')}</p></div>
          {provider === 'makerworld' && printerModels.length > 0 && <label className="block text-sm text-bambu-gray">{t('modelsBrowse.prioritizePrinter')}
            <select value={targetModel} onChange={(event) => setTargetModel(event.target.value)} className={`${controlClass} bg-bambu-dark w-full mt-2`}>
              <option value="">{t('modelsBrowse.allPrinters')}</option>
              {printerModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
          {detail.data.files.length === 0 ? <p className="text-bambu-gray">{t('modelsBrowse.noFiles')}</p> : <fieldset disabled={busy !== null || sliceSource !== null} className="space-y-2 max-h-96 overflow-y-auto p-1">
            <legend className="sr-only">{t('modelsBrowse.chooseFile')}</legend>
            {orderedFiles.map((item) => <label key={item.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${selectedFile === item.id ? 'border-bambu-green bg-bambu-green/5' : 'border-bambu-dark-tertiary hover:border-bambu-gray'}`}>
              <input type="radio" name="model-file" value={item.id} checked={selectedFile === item.id} onChange={() => { setSelectedFile(item.id); setActionError(null); setSaved(null); }} className="mt-1 accent-bambu-green focus-visible:outline-bambu-green" />
              <span className="min-w-0"><span className="block text-sm font-medium text-white break-words">{item.name}</span><span className="block mt-1 text-xs text-bambu-gray">{item.format.toUpperCase()}{item.size !== null ? ` · ${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(item.size / 1048576)} MB` : ''}{!item.sliceable ? ` · ${t('modelsBrowse.saveOnly')}` : ''}</span>
                {profilePrinters(item).length > 0 && <span className="block mt-1 text-xs text-bambu-gray">{profilePrinters(item).join(' · ')}</span>}
                {targetModel && profileCompatibility(item, targetModel) === 'declared' && <span className="block mt-1 text-xs text-bambu-green">{t('modelsBrowse.providerCompatible', { model: targetModel })}</span>}
              </span>
            </label>)}
          </fieldset>}
          {file && targetModel && profileCompatibility(file, targetModel) !== 'declared' && <p role="status" className="text-sm text-yellow-400">{t('modelsBrowse.profileWarning', { model: targetModel })}</p>}
          {file && <ProfileSummary metadata={file.metadata} />}
          {file && Object.keys(file.metadata).length > 0 && <Metadata metadata={file.metadata} label={t('modelsBrowse.fileDetails')} />}
          {!canPrepare ? <p className="text-sm text-bambu-gray">{t('modelsBrowse.importPermission')}</p> : <>
            <label className="block text-sm text-bambu-gray">{t('modelsBrowse.destination')}
              <select value={folderId ?? ''} onChange={(event) => { setFolderId(event.target.value === '' ? null : Number(event.target.value)); setSaved(null); }} disabled={busy !== null || folders.isPending || folders.isError} className={`${controlClass} bg-bambu-dark w-full mt-2`}>
                <option value="">{t('modelsBrowse.libraryRoot')}</option>
                {writableFolders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            {folders.isError && <ModelsError error={folders.error} onRetry={() => void folders.refetch()} compact />}
            <div className="flex flex-wrap gap-3">
              <button className={`${controlClass} !bg-bambu-green !text-bambu-dark !border-bambu-green font-semibold`} disabled={!file || busy !== null || sliceSource !== null || cleanupId !== null || !validFolder || folders.isPending || folders.isError} onClick={() => void prepare('save')}>
                {busy === 'save' ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <Save className="h-4 w-4" />}{t(busy === 'save' ? 'modelsBrowse.saving' : 'modelsBrowse.save')}
              </button>
              <button className={controlClass} disabled={!file?.sliceable || busy !== null || sliceSource !== null || cleanupId !== null} onClick={() => void prepare('slice')}>
                {busy === 'slice' ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <Scissors className="h-4 w-4" />}{t(busy === 'slice' ? 'modelsBrowse.preparing' : 'modelsBrowse.slice')}
              </button>
            </div>
            <p className="text-xs text-bambu-gray">{t('modelsBrowse.sliceHint')}</p>
          </>}
          {busy && <p role="status" className="text-sm text-bambu-gray">{t('modelsBrowse.preparingHint')}</p>}
          {saved && <div role="status" className="rounded-lg bg-bambu-green/10 p-3 text-sm text-bambu-green"><p className="flex items-center gap-2"><Check className="h-4 w-4" />{t(saved.was_existing ? 'modelsBrowse.alreadySaved' : 'modelsBrowse.saved', { filename: saved.filename })}</p><Link to={`/files?highlight=${saved.library_file_id}`} className="mt-2 inline-block underline underline-offset-4">{t('modelsBrowse.library')}</Link></div>}
          {actionError != null && <ModelsError error={actionError} onRetry={() => void prepare(lastAction)} />}
          {cleanupError != null && <div><p className="text-sm text-bambu-gray mb-2">{t('modelsBrowse.cleanupError')}</p><ModelsError error={cleanupError} onRetry={() => { if (cleanupId !== null) void cleanup(cleanupId); }} /></div>}
        </section>
      </div>
      <section className="rounded-xl border border-bambu-dark-tertiary p-4 md:p-6 space-y-4">
        <h3 className="text-lg font-semibold text-white">{t('modelsBrowse.description')}</h3>
        {html ? <div className="text-sm leading-relaxed text-bambu-gray break-words overflow-x-auto [&_p]:mb-3 [&_h2]:text-lg [&_h3]:text-base [&_h2]:text-white [&_h3]:text-white [&_a]:text-bambu-green [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:whitespace-pre-wrap [&_table]:border-collapse [&_td]:p-2" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="text-sm text-bambu-gray">{t('modelsBrowse.noDescription')}</p>}
      </section>
      {Object.keys(detail.data.metadata).length > 0 && <Metadata metadata={detail.data.metadata} label={t('modelsBrowse.modelDetails')} />}
    </>}
    {sliceSource && <SliceModal source={{ kind: 'libraryFile', id: sliceSource.library_file_id, filename: sliceSource.filename }} onClose={closeSlice} />}
  </div>;
}

function ProfileSummary({ metadata }: { metadata: Record<string, unknown> }) {
  const { t } = useTranslation();
  const plates = Array.isArray(metadata.plates) ? metadata.plates.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object') : [];
  if (!plates.length) return null;
  return <div className="space-y-2 text-sm text-bambu-gray">
    <p>{t('modelsBrowse.plateCount', { count: plates.length })}{metadata.requires_ams === true ? ' · AMS' : ''}</p>
    {plates.map((plate, index) => {
      const filaments = Array.isArray(plate.filaments) ? plate.filaments.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object') : [];
      return <div key={index} className="rounded-lg bg-bambu-dark p-3">
        <p className="text-white">{t('modelsBrowse.plateNumber', { number: typeof plate.index === 'number' ? plate.index : index + 1 })}{typeof plate.name === 'string' && plate.name ? ` · ${plate.name}` : ''}</p>
        <ul className="mt-2 flex flex-wrap gap-3">{filaments.map((material, slot) => <li key={slot} className="flex items-center gap-2">
          {typeof material.color === 'string' && /^#[0-9a-f]{6}$/i.test(material.color) && <span className="w-3 h-3 rounded-full border border-bambu-gray" style={{ backgroundColor: material.color }} aria-hidden="true" />}
          <span>{typeof material.type === 'string' ? material.type : t('modelsBrowse.materialSlot', { number: slot + 1 })}{typeof material.usedG === 'string' || typeof material.usedG === 'number' ? ` · ${material.usedG} g` : ''}</span>
        </li>)}</ul>
      </div>;
    })}
  </div>;
}

/** Upstream compatibility/filament/plate fields vary; preserve their full data
 * rather than inventing compatibility from filenames or dropping unknown keys. */
function Metadata({ metadata, label }: { metadata: Record<string, unknown>; label: string }) {
  return <details className="rounded-lg border border-bambu-dark-tertiary p-3 text-sm text-bambu-gray">
    <summary className="cursor-pointer text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green"><FileBox className="inline h-4 w-4 mr-2" aria-hidden="true" />{label}</summary>
    <dl className="mt-3 space-y-3">{Object.entries(metadata).map(([key, value]) => <div key={key}><dt className="font-medium text-white break-words">{key.replace(/_/g, ' ')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-xs">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd></div>)}</dl>
  </details>;
}

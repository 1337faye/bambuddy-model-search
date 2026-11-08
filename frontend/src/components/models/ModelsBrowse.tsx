import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Heart, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import type { ModelCard, ModelProvider, ModelSort } from '../../types/models';
import { ModelDetailView } from './ModelDetailView';
import { ModelImage, ModelsError, controlClass } from './shared';
import { providerName } from './modelUtils';

const PAGE_SIZE = 24;
const sorts: ModelSort[] = ['trending', 'popular', 'newest', 'relevance'];

export function ModelsBrowse() {
  const { t } = useTranslation();
  const { hasPermission, hasAnyPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const providers: ModelProvider[] = [];
  if (hasPermission('makerworld:view')) providers.push('makerworld');
  if (hasAnyPermission('library:read_own', 'library:read_all', 'library:read')) providers.push('printables');
  const requested = params.get('provider');
  const provider = providers.find((p) => p === requested) ?? (providers.length > 1 ? 'all' : providers[0]);
  const query = params.get('query') ?? '';
  const [input, setInput] = useState(query);
  const sort = sorts.find((s) => s === params.get('sort')) ?? 'trending';
  const category = provider === 'all' ? '' : params.get('category') ?? '';
  const model = params.get('model');

  // Back/forward restores the field; typing only updates the URL after 350 ms.
  useEffect(() => { setInput(query); }, [query]);
  useEffect(() => {
    if (input.trim() === query) return;
    const timer = window.setTimeout(() => setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (input.trim()) next.set('query', input.trim()); else next.delete('query');
      next.delete('makerworldOffset');
      next.delete('printablesOffset');
      return next;
    }, { replace: true }), 350);
    return () => window.clearTimeout(timer);
  }, [input, query, setParams]);

  const changeFilter = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set('tab', 'discover');
    next.set(key, value);
    next.delete('model');
    next.delete('makerworldOffset');
    next.delete('printablesOffset');
    if (key === 'provider') next.delete('category');
    return next;
  });
  const openModel = (card: ModelCard) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set('tab', 'discover');
    next.set('from', provider ?? 'all');
    next.set('provider', card.provider);
    next.set('model', card.id);
    return next;
  });
  const closeModel = () => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.delete('model');
    const from = next.get('from');
    if (from) next.set('provider', from);
    next.delete('from');
    return next;
  });

  if (!provider) return <p role="alert">{t('modelsBrowse.noPermission')}</p>;
  if (model) {
    // Never silently resolve a deep link against a different provider when its
    // original provider is forbidden (or the link is malformed).
    if (!providers.some((p) => p === requested)) return <div className="space-y-4"><button className={controlClass} onClick={closeModel}>{t('modelsBrowse.back')}</button><p role="alert">{t('modelsBrowse.noPermission')}</p></div>;
    return <ModelDetailView key={`${requested}:${model}`} provider={requested as ModelProvider} id={model} onBack={closeModel} />;
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('modelsBrowse.provider')}>
          {(providers.length > 1 ? ['all' as const, ...providers] : providers).map((p) =>
            <button key={p} type="button" aria-pressed={provider === p} onClick={() => changeFilter('provider', p)}
              className={`${controlClass} ${provider === p ? '!border-bambu-green !text-bambu-green bg-bambu-green/10' : ''}`}>
              {p === 'all' ? t('modelsBrowse.allProviders') : providerName(p)}
            </button>)}
        </div>
        <div className="flex flex-col md:flex-row gap-3">
          <label className="flex-1 min-w-0">
            <span className="sr-only">{t('modelsBrowse.search')}</span>
            <div className="relative"><Search className="absolute left-3 top-3.5 h-5 w-5 text-bambu-gray" aria-hidden="true" />
              <input type="search" value={input} onChange={(event) => setInput(event.target.value)}
                placeholder={t('modelsBrowse.searchPlaceholder')} className={`${controlClass} w-full pl-10 bg-bambu-dark`} />
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm text-bambu-gray">
            {t('modelsBrowse.sort')}
            <select value={provider === 'printables' && sort === 'trending' ? 'popular' : sort} onChange={(event) => changeFilter('sort', event.target.value)} className={`${controlClass} bg-bambu-dark`}>
              {sorts.filter((s) => provider !== 'printables' || s !== 'trending').map((s) => <option key={s} value={s}>{t(s === 'newest' && provider === 'makerworld' ? 'modelsBrowse.recentMakerworld' : `modelsBrowse.${s}`)}</option>)}
            </select>
          </label>
          {provider !== 'all' && <Categories key={provider} provider={provider} value={category} onChange={(value) => changeFilter('category', value)} />}
        </div>
      </div>
      {(provider === 'all' ? providers : [provider]).map((p) =>
        <ProviderResults key={`${p}:${query}:${sort}:${category}`} provider={p} query={query} sort={sort} category={category} onOpen={openModel} />)}
    </div>
  );
}

function Categories({ provider, value, onChange }: { provider: ModelProvider; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const categories = useQuery({
    queryKey: ['models', user?.id, provider, 'categories'],
    queryFn: ({ signal }) => api.getModelCategories(provider, signal),
    staleTime: 300_000, gcTime: 120_000, retry: false,
  });
  return <div>
    <label className="flex items-center gap-2 text-sm text-bambu-gray">{t('modelsBrowse.category')}
      <select className={`${controlClass} bg-bambu-dark max-w-64`} value={value} onChange={(e) => onChange(e.target.value)} disabled={categories.isPending || categories.isError}>
        <option value="">{t('modelsBrowse.allCategories')}</option>
        {value && !categories.data?.some((item) => item.id === value) && <option value={value}>{value}</option>}
        {categories.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {categories.isError && <ModelsError error={categories.error} onRetry={() => void categories.refetch()} compact />}
  </div>;
}

function ProviderResults({ provider, query, sort, category, onOpen }: {
  provider: ModelProvider; query: string; sort: ModelSort; category: string; onOpen: (card: ModelCard) => void;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const rawOffset = Number(params.get(`${provider}Offset`) ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const effectiveSort = provider === 'printables' && sort === 'trending' ? 'popular' : sort;
  const results = useQuery({
    queryKey: ['models', user?.id, provider, 'browse', query, effectiveSort, category, offset],
    queryFn: ({ signal }) => api.browseModels(provider, { query, sort: effectiveSort, category, offset, limit: PAGE_SIZE }, signal),
    staleTime: 60_000, gcTime: 120_000, retry: false,
  });
  // Page-sized rendering (never an unbounded growing grid), short-lived cache,
  // plus a hard cap on inactive discovery queries for long browsing sessions.
  useEffect(() => {
    const inactive = client.getQueryCache().findAll({ queryKey: ['models'], type: 'inactive' })
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    inactive.slice(32).forEach((entry) => client.removeQueries({ queryKey: entry.queryKey, exact: true }));
  }, [client, results.dataUpdatedAt]);
  const page = (nextOffset: number) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(`${provider}Offset`, String(nextOffset));
    return next;
  });
  const headingId = `${provider}-results`;
  const number = (value: number) => new Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(value);

  return <section aria-labelledby={headingId} className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={headingId} className="text-lg font-semibold text-white">{providerName(provider)}
        <span className="ml-3 text-sm font-normal text-bambu-gray">{t(effectiveSort === 'newest' && provider === 'makerworld' ? 'modelsBrowse.recentMakerworld' : `modelsBrowse.${effectiveSort}`)}</span>
      </h2>
      {results.data?.total != null && <span className="text-sm text-bambu-gray">{t('modelsBrowse.results', { count: results.data.total })}</span>}
    </div>
    {results.isPending ? <div role="status" aria-label={t('modelsBrowse.loading')} className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="rounded-xl bg-bambu-dark-secondary overflow-hidden motion-safe:animate-pulse"><div className="aspect-[4/3] bg-bambu-dark-tertiary" /><div className="h-16 m-3 rounded bg-bambu-dark-tertiary" /></div>)}
    </div> : results.isError ? <ModelsError error={results.error} onRetry={() => void results.refetch()} /> : results.data.items.length === 0 ?
      <div className="rounded-xl border border-dashed border-bambu-dark-tertiary p-10 text-center"><Search className="h-8 w-8 text-bambu-gray mx-auto mb-3" aria-hidden="true" /><h3 className="text-white font-medium">{t('modelsBrowse.empty')}</h3><p className="mt-2 text-sm text-bambu-gray">{t('modelsBrowse.emptyHint')}</p></div> :
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {results.data.items.map((card) => <button key={`${card.provider}:${card.id}`} onClick={() => onOpen(card)} className="group min-w-0 text-left rounded-xl overflow-hidden border border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-bambu-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green focus-visible:outline-offset-2">
          <div className="aspect-[4/3] overflow-hidden bg-bambu-dark"><ModelImage provider={provider} url={card.thumbnail} alt="" className="w-full h-full object-cover motion-safe:transition-transform motion-safe:group-hover:scale-105" /></div>
          <div className="p-3 md:p-4"><h3 className="line-clamp-2 text-sm md:text-base font-semibold text-white break-words">{card.title}</h3>
            <p className="mt-1 truncate text-xs text-bambu-gray">{card.creator}</p>
            <div className="flex flex-wrap gap-3 mt-3 text-xs text-bambu-gray">
              {card.downloads !== null && <span className="flex items-center gap-1" aria-label={t('modelsBrowse.downloads', { count: card.downloads })}><Download className="h-3.5 w-3.5" aria-hidden="true" />{number(card.downloads)}</span>}
              {card.likes !== null && <span className="flex items-center gap-1" aria-label={t('modelsBrowse.likes', { count: card.likes })}><Heart className="h-3.5 w-3.5" aria-hidden="true" />{number(card.likes)}</span>}
            </div>
          </div>
        </button>)}
      </div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button className={controlClass} onClick={() => page(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || results.isFetching}><ChevronLeft className="h-4 w-4" aria-hidden="true" />{t('modelsBrowse.previous')}</button>
      <span className="text-sm text-bambu-gray" aria-live="polite">{t('modelsBrowse.page', { page: Math.floor(offset / PAGE_SIZE) + 1 })}</span>
      <button className={controlClass} onClick={() => page(offset + PAGE_SIZE)} disabled={!results.data?.has_more || results.isFetching || results.isError}>{t('modelsBrowse.next')}<ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
    </div>
  </section>;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ModelSourcesPage } from '../../pages/ModelSourcesPage';
import { setAuthToken } from '../../api/client';
import type { ModelCard, ModelDetail, ModelProvider } from '../../types/models';

// Exercise the discovery → prepare → existing SliceModal contract without
// involving the slicer's printer, filament and preset APIs in discovery tests.
vi.mock('../../components/SliceModal', () => ({
  SliceModal: ({ source, onClose }: { source: { kind: string; id: number; filename: string }; onClose: () => void }) =>
    <div role="dialog" aria-label="In-app slicer"><p>{source.kind}:{source.id}:{source.filename}</p><button onClick={onClose}>Cancel slice</button><button onClick={onClose}>Enqueue complete</button></div>,
}));

const card = (provider: ModelProvider, id = '42'): ModelCard => ({ provider, id, title: `${provider} vase ${id}`, creator: 'Designer', url: `https://${provider}.com/models/${id}`, thumbnail: 'https://images.example.com/vase.jpg', downloads: 120, likes: 4 });
const detail = (provider: ModelProvider): ModelDetail => ({
  ...card(provider), description_html: '<p>A useful vase.</p><img src="https://tracker.example/x"><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://example.com">credits</a>',
  images: ['https://images.example.com/front.jpg', 'https://images.example.com/back.jpg'], license: 'CC BY',
  files: [
    { id: 'stl:49068', name: 'vase.stl', format: 'stl', size: 1048576, sliceable: true, metadata: { printers: ['A1'], filaments: ['PLA'], plates: 1 } },
    { id: 'manual', name: 'instructions.pdf', format: 'pdf', size: 2048, sliceable: false, metadata: {} },
  ], metadata: { profiles: [{ name: 'Standard', printers: ['A1'] }] },
});

function sources({ manyfoldConfigured = true } = {}) {
  const served = { status: 0, browse: [] as URL[], prepares: [] as unknown[], deleted: [] as string[] };
  server.use(
    http.get('*/models/:provider/browse', ({ request, params }) => {
      const url = new URL(request.url);
      served.browse.push(url);
      return HttpResponse.json({ items: [card(params.provider as ModelProvider, url.searchParams.get('offset') === '24' ? '43' : '42')], total: 25, has_more: url.searchParams.get('offset') !== '24' });
    }),
    http.get('*/models/:provider/categories', () => HttpResponse.json([{ id: 'art', name: 'Art & sculpture' }])),
    http.get('*/models/:provider/:id', ({ params }) => HttpResponse.json(detail(params.provider as ModelProvider))),
    http.post('*/models/:provider/:id/prepare', async ({ request }) => {
      const data = await request.json() as { action: string };
      served.prepares.push(data);
      return HttpResponse.json({ library_file_id: 81, filename: 'vase.stl', folder_id: null, was_existing: false, temporary: data.action === 'slice' });
    }),
    http.delete('*/models/temporary/:id', ({ params }) => { served.deleted.push(String(params.id)); return new HttpResponse(null, { status: 204 }); }),
    http.get('*/makerworld/status', () => HttpResponse.json({ has_cloud_token: true, can_download: true })),
    http.get('*/makerworld/recent-imports', () => HttpResponse.json([])),
    http.get('*/library/folders', () => HttpResponse.json([
      { id: 7, name: 'Projects', parent_id: null, can_write: true, external_readonly: false, children: [{ id: 8, name: 'Vases', can_write: true, external_readonly: false, children: [] }] },
      { id: 9, name: 'Read-only', can_write: false, children: [] },
    ])),
    http.get('*/settings/', () => HttpResponse.json({ preferred_slicer: 'bambu_studio' })),
    http.get('*/manyfold/status', () => {
      served.status += 1;
      return HttpResponse.json({ configured: manyfoldConfigured, url: manyfoldConfigured ? 'http://mf' : '' });
    }),
    http.get('*/manyfold/config', () => HttpResponse.json({ url: '', client_id: '', has_client_secret: false, configured: false })),
    http.get('*/manyfold/models', () => HttpResponse.json({ total: 1, page: 1, has_next: false, has_previous: false, models: [{ id: 'm1', name: 'Benchy' }] })),
    http.get('*/manyfold/models/:id/preview', () => new HttpResponse(null, { status: 404 })),
  );
  return served;
}

function signedInWith(permissions: string[]) {
  server.use(
    http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('*/api/v1/auth/me', () => HttpResponse.json({ id: 3, username: 'member', role: 'user', is_active: true, is_admin: false, groups: [], permissions, created_at: '2026-01-01T00:00:00Z' })),
  );
  setAuthToken('test-token', 'session');
}

function openDetail(provider: ModelProvider = 'printables') {
  window.history.replaceState({}, '', `/model-sources?tab=discover&provider=${provider}&model=42`);
  return render(<ModelSourcesPage />);
}

describe('Models discovery', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    window.history.replaceState({}, '', '/model-sources');
  });
  afterEach(() => { setAuthToken(null); });

  it('discovers both sources by default and preserves Manyfold', async () => {
    const user = userEvent.setup();
    const served = sources();
    render(<ModelSourcesPage />);
    expect(await screen.findByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(await screen.findByText('makerworld vase 42')).toBeInTheDocument();
    expect(await screen.findByText('printables vase 42')).toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Library' })).toHaveAttribute('href', '/files');
    expect(served.browse.find((url) => url.pathname.includes('printables'))?.searchParams.get('sort')).toBe('popular');
    await user.click(await screen.findByRole('button', { name: 'Manyfold' }));
    expect(await screen.findByText('Benchy')).toBeInTheDocument();
    expect(window.location.search).toContain('tab=manyfold');
  });

  it('keeps legacy URL import at tab=import and old tab=makerworld bookmarks', async () => {
    sources();
    window.history.replaceState({}, '', '/model-sources?tab=import');
    render(<ModelSourcesPage />);
    expect(await screen.findByText('Import from MakerWorld')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import URL' })).toHaveAttribute('aria-current', 'page');
  });

  it('lets library-only users discover Printables, never requesting MakerWorld', async () => {
    const served = sources();
    signedInWith(['library:read_own']);
    render(<ModelSourcesPage />);
    expect(await screen.findByText('printables vase 42')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MakerWorld' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import URL' })).not.toBeInTheDocument();
    expect(served.browse.every((url) => url.pathname.includes('printables'))).toBe(true);
    expect(screen.getByLabelText('Sort')).toHaveValue('popular');
  });

  it('retains a Manyfold-only landing including not-connected state', async () => {
    sources({ manyfoldConfigured: false });
    signedInWith(['manyfold:view']);
    render(<ModelSourcesPage />);
    expect(await screen.findByText('Manyfold is not connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discover' })).not.toBeInTheDocument();
  });

  it('hides unconfigured Manyfold unless the user can connect it', async () => {
    const served = sources({ manyfoldConfigured: false });
    signedInWith(['makerworld:view', 'manyfold:view']);
    render(<ModelSourcesPage />);
    expect(await screen.findByText('makerworld vase 42')).toBeInTheDocument();
    await waitFor(() => expect(served.status).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Manyfold' })).not.toBeInTheDocument();
  });

  it('lets settings users connect unconfigured Manyfold', async () => {
    const user = userEvent.setup();
    sources({ manyfoldConfigured: false });
    signedInWith(['makerworld:view', 'manyfold:view', 'settings:update']);
    render(<ModelSourcesPage />);
    await user.click(await screen.findByRole('button', { name: 'Manyfold' }));
    expect(await screen.findByText('Manyfold connection')).toBeInTheDocument();
  });

  it('shows independent provider errors with retry while the other source works', async () => {
    const user = userEvent.setup();
    sources();
    let failed = true;
    server.use(http.get('*/models/makerworld/browse', () => failed ? HttpResponse.json({ detail: 'Provider sign-in required' }, { status: 403 }) : HttpResponse.json({ items: [card('makerworld')], total: 1, has_more: false })));
    render(<ModelSourcesPage />);
    expect(await screen.findByText('printables vase 42')).toBeInTheDocument();
    expect(await screen.findByText(/Access required/)).toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('makerworld vase 42')).toBeInTheDocument();
  });

  it('debounces a unified search and paginates sources independently', async () => {
    const user = userEvent.setup();
    const served = sources();
    render(<ModelSourcesPage />);
    await screen.findByText('makerworld vase 42');
    await user.type(screen.getByRole('searchbox'), 'vase');
    expect(served.browse.filter((url) => url.searchParams.get('query'))).toHaveLength(0);
    await waitFor(() => expect(served.browse.filter((url) => url.searchParams.get('query') === 'vase')).toHaveLength(2));
    const mw = screen.getByRole('region', { name: 'MakerWorld Trending' });
    await user.click(within(mw).getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('makerworld vase 43')).toBeInTheDocument();
    expect(screen.getByText('printables vase 42')).toBeInTheDocument();
    expect(served.browse.every((url) => url.searchParams.get('limit') === '24')).toBe(true);
  });

  it('shows single-provider categories and encodes a stable detail deep link', async () => {
    const user = userEvent.setup();
    const served = sources();
    render(<ModelSourcesPage />);
    await user.click(await screen.findByRole('button', { name: 'MakerWorld', exact: true }));
    await user.selectOptions(await screen.findByLabelText('Category'), 'art');
    await waitFor(() => expect(served.browse.some((url) => url.searchParams.get('category') === 'art')).toBe(true));
    await user.click(await screen.findByRole('button', { name: /makerworld vase 42/ }));
    expect(await screen.findByRole('heading', { name: 'makerworld vase 42' })).toBeInTheDocument();
    expect(window.location.search).toContain('provider=makerworld');
    expect(window.location.search).toContain('model=42');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sanitizes description, proxies galleries, and requires deliberate file selection', async () => {
    sources();
    const { container } = openDetail();
    expect(await screen.findByRole('heading', { name: 'printables vase 42' })).toBeInTheDocument();
    expect(screen.getByText('A useful vase.')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src*="tracker"]')).toBeNull();
    expect(screen.getByText('bad')).not.toHaveAttribute('href');
    expect(screen.getByRole('link', { name: 'credits' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('img', { name: 'printables vase 42' }).getAttribute('src')).toContain('/api/v1/models/printables/thumbnail?url=');
    expect(screen.getByRole('button', { name: 'Save to Library' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Slice in Bambuddy' })).toBeDisabled();
  });

  it('saves only the chosen file to the chosen writable destination, without slicing', async () => {
    const user = userEvent.setup();
    const served = sources();
    openDetail();
    await user.click(await screen.findByRole('radio', { name: /vase.stl/ }));
    await user.selectOptions(screen.getByLabelText('Save destination'), '8');
    expect(screen.queryByRole('option', { name: 'Read-only' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save to Library' }));
    expect(await screen.findByText('vase.stl was saved to your Library.')).toBeInTheDocument();
    expect(served.prepares).toEqual([{ file_id: 'stl:49068', action: 'save', folder_id: 8 }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(served.deleted).toEqual([]);
  });

  it.each(['Cancel slice', 'Enqueue complete'])('slices directly using a temporary library source and cleans up on %s', async (closeLabel) => {
    const user = userEvent.setup();
    const served = sources();
    openDetail();
    await user.click(await screen.findByRole('radio', { name: /vase.stl/ }));
    await user.click(screen.getByRole('button', { name: 'Slice in Bambuddy' }));
    const dialog = await screen.findByRole('dialog', { name: 'In-app slicer' });
    expect(within(dialog).getByText('libraryFile:81:vase.stl')).toBeInTheDocument();
    expect(served.prepares).toEqual([{ file_id: 'stl:49068', action: 'slice', folder_id: null }]);
    await user.click(within(dialog).getByRole('button', { name: closeLabel }));
    await waitFor(() => expect(served.deleted).toEqual(['81']));
  });

  it('does not delete a nontemporary existing library file on slice close', async () => {
    const user = userEvent.setup();
    const served = sources();
    server.use(http.post('*/models/:provider/:id/prepare', () => HttpResponse.json({ library_file_id: 6, filename: 'existing.stl', folder_id: 1, was_existing: true, temporary: false })));
    openDetail();
    await user.click(await screen.findByRole('radio', { name: /vase.stl/ }));
    await user.click(screen.getByRole('button', { name: 'Slice in Bambuddy' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel slice' }));
    expect(served.deleted).toEqual([]);
  });

  it('disables unsupported slice files and hides writes without upload permission', async () => {
    const user = userEvent.setup();
    sources();
    const view = openDetail();
    await user.click(await screen.findByRole('radio', { name: /instructions.pdf/ }));
    expect(screen.getByRole('button', { name: 'Slice in Bambuddy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save to Library' })).toBeEnabled();
    view.unmount();
    signedInWith(['library:read_own']);
    openDetail();
    expect(await screen.findByText(/Saving and slicing require library upload/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to Library' })).not.toBeInTheDocument();
  });

  it('does not reinterpret a forbidden MakerWorld deep link as Printables', async () => {
    const served = sources();
    signedInWith(['library:read_own']);
    openDetail('makerworld');
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(served.browse).toEqual([]);
    expect(screen.queryByText('printables vase 42')).not.toBeInTheDocument();
  });
});

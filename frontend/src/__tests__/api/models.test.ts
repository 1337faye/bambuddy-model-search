import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { api, setAuthToken, setMediaToken } from '../../api/client';

afterEach(() => { setAuthToken(null); setMediaToken(null); });

describe('Models API client', () => {
  it('encodes search filters and passes existing authorization', async () => {
    let seen: Request | undefined;
    server.use(http.get('*/api/v1/models/printables/browse', ({ request }) => {
      seen = request;
      return HttpResponse.json({ items: [], total: 0, has_more: false });
    }));
    setAuthToken('test-token');
    await api.browseModels('printables', { query: 'vase & lid', category: 'a/b', sort: 'relevance', offset: 24, limit: 24 });
    expect(new URL(seen!.url).searchParams.get('query')).toBe('vase & lid');
    expect(new URL(seen!.url).searchParams.get('category')).toBe('a/b');
    expect(seen!.headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('consumes the query AbortSignal so stale browsing requests can be canceled', async () => {
    server.use(http.get('*/api/v1/models/makerworld/browse', async () => {
      await delay(100);
      return HttpResponse.json({ items: [], total: 0, has_more: false });
    }));
    const controller = new AbortController();
    const result = api.browseModels('makerworld', { query: '', category: '', sort: 'trending', offset: 0, limit: 24 }, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('encodes the provider URL only inside the authenticated image proxy URL', () => {
    setMediaToken('media-test');
    const url = new URL(api.getModelThumbnailUrl('printables', 'https://cdn.example/image.jpg?a=1&b=2'), 'http://localhost');
    expect(url.pathname).toBe('/api/v1/models/printables/thumbnail');
    expect(url.searchParams.get('url')).toBe('https://cdn.example/image.jpg?a=1&b=2');
    expect(url.searchParams.get('token')).toBe('media-test');
  });
});

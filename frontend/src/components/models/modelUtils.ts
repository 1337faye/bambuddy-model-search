import DOMPurify from 'dompurify';
import type { ModelProvider } from '../../types/models';

export const providerName = (provider: ModelProvider) => provider === 'makerworld' ? 'MakerWorld' : 'Printables';

export function safeExternalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}

/** Allow formatted prose, not remote tracking images, styles, embeds or scripts. */
export function sanitizeModelDescription(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title'],
    RETURN_DOM: true,
  }) as HTMLElement;
  fragment.querySelectorAll('a').forEach((anchor) => {
    const href = safeExternalUrl(anchor.getAttribute('href') ?? '');
    if (!href) anchor.removeAttribute('href');
    else { anchor.setAttribute('href', href); anchor.setAttribute('target', '_blank'); anchor.setAttribute('rel', 'noopener noreferrer'); }
  });
  return fragment.innerHTML;
}

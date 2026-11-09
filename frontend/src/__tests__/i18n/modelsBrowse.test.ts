import { describe, expect, it } from 'vitest';
import type { ResourceLanguage } from 'i18next';
import { modelsBrowseEnglish, withModelsBrowseTranslations } from '../../i18n/modelsBrowse';

const locales = import.meta.glob<{ default: ResourceLanguage }>('../../i18n/locales/*.ts', { eager: true });

describe('Models discovery locale parity', () => {
  it.each(Object.entries(locales))('installs every modelsBrowse key in %s', (_path, module) => {
    const resource = withModelsBrowseTranslations(module.default);
    expect(Object.keys(resource.modelsBrowse).sort()).toEqual(Object.keys(modelsBrowseEnglish).sort());
    for (const [key, value] of Object.entries(modelsBrowseEnglish)) {
      const actual = resource.modelsBrowse[key] as string;
      expect(actual.match(/\{\{[^}]+\}\}/g)).toEqual(value.match(/\{\{[^}]+\}\}/g));
    }
    expect(module.default.nav.modelSources).not.toBe('Model Sources');
  });

  it('allows localized strings to override the explicit English fallback', () => {
    expect(withModelsBrowseTranslations({ modelsBrowse: { discover: 'Entdecken' } }).modelsBrowse.discover).toBe('Entdecken');
  });
});

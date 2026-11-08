import { describe, expect, it } from 'vitest';
import type { ModelFile } from '../../types/models';
import { prioritizeProfiles, profileCompatibility, profilePrinters } from '../../components/models/profileCompatibility';
const file = (id: string, metadata: Record<string, unknown>, name = 'Profile'): ModelFile => ({ id, metadata, name, format: '3mf', size: null, sliceable: true });
describe('online profile compatibility', () => {
  it('recognizes X2D only from provider declared N6 compatibility, retaining all AMS data', () => {
    const metadata = { printer: { devModelName: 'N2S' }, compatible_printers: [{ devModelName: 'N6' }], plates: [{ index: 2, filaments: [{ id: 1, color: '#FF0000' }, { id: 2, color: '#00FF00' }] }] };
    const compatible = file('1', metadata);
    expect(profilePrinters(compatible)).toEqual(['A1', 'X2D']);
    expect(profileCompatibility(compatible, 'X2D')).toBe('declared');
    expect(compatible.metadata).toEqual(metadata);
  });
  it('does not infer installed slicer or model compatibility from a title string', () => {
    expect(profileCompatibility(file('1', {}, 'Bambu X2D AMS'), 'X2D')).toBe('unknown');
    expect(profileCompatibility(file('2', { printer: { devModelName: 'N2S' } }), 'X2D')).toBe('different');
  });
  it('prioritizes compatible profiles without merging or dropping file choices', () => {
    const all = [file('1', {}), file('2', { printer: { devModelName: 'N6' } }), file('3', {})];
    expect(prioritizeProfiles(all, 'X2D').map(f => f.id)).toEqual(['2', '1', '3']);
    expect(all.map(f => f.id)).toEqual(['1', '2', '3']);
  });
});

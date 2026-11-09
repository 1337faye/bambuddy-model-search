import { mapModelCode } from '../../utils/printerModel';
import type { ModelFile } from '../../types/models';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function profilePrinters(file: ModelFile): string[] {
  const entries = [file.metadata.printer, ...(Array.isArray(file.metadata.compatible_printers) ? file.metadata.compatible_printers : [])];
  return Array.from(new Set(entries.flatMap((value) => {
    const printer = record(value);
    const model = printer?.devModelName ?? printer?.devProductName;
    return typeof model === 'string' && model ? [mapModelCode(model)] : [];
  })));
}

/** A provider declaration, not proof the installed slicer supports this printer.
 * Unknown compatibility stays unknown, never guessed from a profile title. */
export function profileCompatibility(file: ModelFile, model: string): 'declared' | 'unknown' | 'different' {
  const printers = profilePrinters(file);
  return !printers.length ? 'unknown' : printers.includes(mapModelCode(model)) ? 'declared' : 'different';
}

export function prioritizeProfiles(files: ModelFile[], model: string): ModelFile[] {
  if (!model) return files;
  return [...files].sort((a, b) => Number(profileCompatibility(b, model) === 'declared') - Number(profileCompatibility(a, model) === 'declared'));
}

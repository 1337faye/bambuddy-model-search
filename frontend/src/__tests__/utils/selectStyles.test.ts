import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync(resolve(__dirname, '../../index.css'), 'utf8'));
const dropdownSelector = 'select:not([multiple]):not([size])';
const dropdownRule = css.nodes.find((node): node is Rule => node.type === 'rule' && node.selector.split(',')[0].trim() === dropdownSelector)!;
const declarations = (rule: Rule) => Object.fromEntries(rule.nodes.flatMap(node => node.type === 'decl' ? [[node.prop, node.value]] : []));

describe('application-wide select arrow spacing', () => {
  it('covers ordinary selects and size=1, without replacing listboxes', () => {
    expect(dropdownRule).toBeDefined();
    expect(dropdownRule.selector).toContain('select:not([multiple])[size="1"]');
    expect(dropdownRule.selector.split(',').every(selector => selector.includes(':not([multiple])'))).toBe(true);
    expect(dropdownRule.parent?.type).toBe('root'); // wins over px/pr utility layers
  });

  it('reserves text clearance plus an inset, vertically centered indicator', () => {
    const styles = declarations(dropdownRule);
    expect(styles.appearance).toBe('none');
    expect(styles['-webkit-appearance']).toBe('none');
    expect(styles['padding-inline-end']).toBe('2.5rem');
    expect(styles['background-position']).toBe('right 0.75rem center');
    expect(styles['background-size']).toBe('1rem 1rem');
    expect(styles['background-repeat']).toBe('no-repeat');
    expect(styles['background-image']).toContain('data:image/svg+xml');
  });

  it('supports RTL, dark theme, existing overlaid chevrons and forced-colors', () => {
    const rules: Rule[] = [];
    css.walkRules(rule => { rules.push(rule); });
    expect(rules.find(rule => rule.selector.includes(':dir(rtl)'))?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ prop: 'background-position', value: 'left 0.75rem center' })]));
    expect(rules.find(rule => rule.selector.startsWith('.dark select'))).toBeDefined();
    expect(declarations(rules.find(rule => rule.selector.includes('+ svg.lucide-chevron-down'))!).display).toBe('none');
    const contrast = rules.find(rule => rule.parent?.type === 'atrule' && rule.parent.params === '(forced-colors: active)' && rule.selector.includes(dropdownSelector))!;
    expect(contrast.selector).toContain('.dark select'); // override dark indicator specificity too
    expect(declarations(contrast)).toMatchObject({ appearance: 'auto', 'background-image': 'none' });
  });
});

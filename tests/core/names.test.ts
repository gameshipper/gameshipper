import { describe, expect, it } from 'vitest';
import { defaultBundleId, slugify, titleCase } from '../../src/core/names.js';

describe('names', () => {
  it('slugify', () => {
    expect(slugify('Capybara Delivery!')).toBe('capybara-delivery');
    expect(slugify('  --  ')).toBe('game');
  });
  it('titleCase', () => {
    expect(titleCase('capybara-delivery_game')).toBe('Capybara Delivery Game');
  });
  it('defaultBundleId', () => {
    expect(defaultBundleId('Capybara Delivery')).toBe('local.gameshipper.capybaradelivery');
  });
});

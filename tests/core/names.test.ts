import { describe, expect, it } from 'vitest';
import { defaultBundleId, fileSafeName, slugify, titleCase } from '../../src/core/names.js';

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
  it('fileSafeName matches the names @electron/packager gives .exe and .app files', () => {
    expect(fileSafeName('Moon Game')).toBe('Moon Game');
    expect(fileSafeName('Space: The Game')).toBe('Space- The Game');
    expect(fileSafeName('Who? What/Why')).toBe('Who- What-Why');
    expect(fileSafeName('Tag<<>>')).toBe('Tag-');
    expect(fileSafeName('Wait...')).toBe('Wait');
    expect(fileSafeName('CON')).toBe('CON-');
  });
});

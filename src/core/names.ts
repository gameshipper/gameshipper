import filenamify from 'filenamify';

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'game';
}

export function titleCase(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Used for macOS bundles until the user sets mobile.bundleId (required for signing in Plan 5). */
export function defaultBundleId(name: string): string {
  return `local.gameshipper.${slugify(name).replace(/-/g, '')}`;
}

/**
 * The name @electron/packager 20.3.0 gives the Windows .exe and the Mac .app and its binary:
 * it runs the app name through the same filenamify call, so "Space: The Game" → "Space- The Game".
 */
export function fileSafeName(name: string): string {
  return filenamify(name, { replacement: '-' });
}

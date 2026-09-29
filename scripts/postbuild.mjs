import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/shell', { recursive: true });
copyFileSync('src/shell/package.json', 'dist/shell/package.json');

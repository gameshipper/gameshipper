import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.int.test.ts', 'node_modules/**'],
    testTimeout: 30_000,
  },
});

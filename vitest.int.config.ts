import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.int.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Integration tests package real apps; running them side by side makes them fight over downloads and CPU.
    fileParallelism: false,
  },
});

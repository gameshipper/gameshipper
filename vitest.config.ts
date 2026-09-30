import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.int.test.ts', 'node_modules/**'],
    testTimeout: 30_000,
    // Deletes each test file's temp folders when it's done (GAMESHIPPER_KEEP_TMP=1 keeps a failing file's).
    setupFiles: ['tests/setup.ts'],
    // Tests never find the developer's own Steamworks SDK: not through GAMESHIPPER_STEAM_SDK, and not in
    // Gameshipper's cache, which keeps an SDK once a build has used one. They never sign with the developer's
    // Apple identity or notarize either: the Apple variables are set empty, which means unset.
    env: {
      GAMESHIPPER_STEAM_SDK: '',
      GAMESHIPPER_CACHE: path.join(os.tmpdir(), 'gameshipper-test-cache'),
      GAMESHIPPER_MAC_IDENTITY: '',
      GAMESHIPPER_NOTARY_PROFILE: '',
      GAMESHIPPER_NOTARY_KEYCHAIN: '',
      GAMESHIPPER_NOTARY_KEY: '',
      GAMESHIPPER_NOTARY_KEY_ID: '',
      GAMESHIPPER_NOTARY_ISSUER: '',
    },
  },
});

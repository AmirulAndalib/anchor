import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  resolve: {
    alias: { src: path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['test/e2e/specs/**/*.e2e-spec.ts'],
    setupFiles: ['test/e2e/setup/env.ts'],
    globalSetup: ['test/e2e/setup/global-setup.ts'],
    // Every spec shares one database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

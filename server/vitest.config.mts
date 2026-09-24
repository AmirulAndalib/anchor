import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC keeps the decorator metadata Nest's dependency injection reads.
  plugins: [swc.vite()],
  resolve: {
    alias: { src: path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    coverage: {
      include: ['src/**/*.ts'],
    },
  },
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.join(root, 'test/setup-env.ts')],
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      'bun:sqlite': path.join(root, 'test/shims/bun-sqlite.ts'),
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kiwi-reader',
    include: ['test/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});

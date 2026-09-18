import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/live-probe.ts'],
  outDir: 'dist',
  format: 'esm',
  target: 'node24',
  platform: 'node',
  dts: false,
  clean: true,
  shims: false,
  fixedExtension: true,
});

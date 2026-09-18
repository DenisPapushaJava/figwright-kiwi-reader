import { defineConfig } from 'tsdown';

const standaloneDependencies =
  /^(?:@figwright\/shared|@modelcontextprotocol\/(?:server|core)|fzstd|kiwi-schema|ws|zod)(?:\/.*)?$/;

export default defineConfig({
  entry: ['src/index.ts', 'src/live-probe.ts', 'src/mcp.ts', 'src/serve.ts'],
  outDir: 'dist',
  format: 'esm',
  target: 'node24',
  platform: 'node',
  dts: false,
  clean: true,
  shims: false,
  fixedExtension: true,
  // The browser reader ships as a standalone release bundle. Keep its runtime dependencies in the
  // generated files so another developer needs Node 24, but does not need pnpm or node_modules.
  deps: {
    alwaysBundle: standaloneDependencies,
    onlyBundle: standaloneDependencies,
  },
});

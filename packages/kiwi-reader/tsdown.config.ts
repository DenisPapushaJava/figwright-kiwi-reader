import { defineConfig } from 'tsdown';

// fdir and ignore enter through the provider-neutral project walkers reused from packages/mcp.
// Keep them declared on FigLens and bundled here so the release remains standalone; knip cannot
// attribute a dependency imported across a workspace source boundary, so knip.json records the pair.
const standaloneDependencies =
  /^(?:@babel\/parser|@figwright\/shared|@modelcontextprotocol\/(?:server|core)|fdir|fzstd|ignore|kiwi-schema|ws|zod)(?:\/.*)?$/;

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/live-probe.ts',
    'src/mcp.ts',
    'src/hub.ts',
    'src/stdio-proxy.ts',
    'src/client-config.ts',
    'src/serve.ts',
  ],
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

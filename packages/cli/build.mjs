import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // node:sqlite and friends stay external; everything of ours is inlined so the
  // published package has zero runtime dependencies.
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

await chmod('dist/cli.js', 0o755);

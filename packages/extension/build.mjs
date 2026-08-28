import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  alias: { '@greview/protocol': '../cli/src/protocol.ts' },
  sourcemap: true,
  logLevel: 'info',
});

// Ship the CLI inside the extension so a fresh install works before the user has
// installed the global binary. Same source tree, so the two can never disagree
// about the database schema.
await rm('dist/greview-cli.js', { force: true });
await copyFile('../cli/dist/cli.js', 'dist/greview-cli.mjs');

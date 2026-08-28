import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walks up from the working directory to the extension package. The extension is
 * typechecked as CommonJS for VS Code, so `import.meta` is not available here.
 */
function packageRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'greview') return dir;
    } catch {
      // Keep walking; not every ancestor has a manifest.
    }
    dir = dirname(dir);
  }
  throw new Error(`could not find the extension package root from ${process.cwd()}`);
}

const root = packageRoot();

function readJson(path: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, string>;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/**
 * Every translatable key, including calls broken across lines.
 *
 * Two call shapes exist: `l10n.t(...)` where the API is imported directly, and a
 * bare `t(...)` in labels.ts, which takes the translator as a parameter so the
 * label logic can be tested without an extension host.
 */
function runtimeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles('src')) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const m of source.matchAll(/(?:l10n\.)?\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]!);
  }
  return keys;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]!).sort();
}

const LOCALES = ['zh-cn'];

test('every runtime string is translated in every locale', () => {
  const keys = runtimeKeys();
  assert.ok(keys.size > 20, `expected to find the runtime strings, found ${keys.size}`);
  for (const locale of LOCALES) {
    const bundle = readJson(`l10n/bundle.l10n.${locale}.json`);
    const missing = [...keys].filter((k) => !(k in bundle)).sort();
    assert.deepEqual(missing, [], `${locale} is missing translations`);
  }
});

test('no locale carries a translation the code no longer uses', () => {
  const keys = runtimeKeys();
  for (const locale of LOCALES) {
    const bundle = readJson(`l10n/bundle.l10n.${locale}.json`);
    const stale = Object.keys(bundle).filter((k) => !keys.has(k)).sort();
    assert.deepEqual(stale, [], `${locale} has stale translations`);
  }
});

test('translations keep the same placeholders as the source string', () => {
  for (const locale of LOCALES) {
    const bundle = readJson(`l10n/bundle.l10n.${locale}.json`);
    for (const [key, value] of Object.entries(bundle)) {
      assert.deepEqual(
        placeholders(value),
        placeholders(key),
        `${locale}: placeholders differ for "${key}"`,
      );
    }
  }
});

test('every %placeholder% in the manifest is defined, and translated', () => {
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');
  const used = new Set([...manifest.matchAll(/"%([A-Za-z0-9_.]+)%"/g)].map((m) => m[1]!));
  assert.ok(used.size > 10, `expected manifest placeholders, found ${used.size}`);

  const english = readJson('package.nls.json');
  const undefinedKeys = [...used].filter((k) => !(k in english)).sort();
  assert.deepEqual(undefinedKeys, [], 'package.nls.json is missing keys the manifest uses');

  const unused = Object.keys(english).filter((k) => !used.has(k)).sort();
  assert.deepEqual(unused, [], 'package.nls.json defines keys the manifest never uses');

  for (const locale of LOCALES) {
    const translated = readJson(`package.nls.${locale}.json`);
    assert.deepEqual(
      Object.keys(translated).sort(),
      Object.keys(english).sort(),
      `package.nls.${locale}.json must cover exactly the English keys`,
    );
  }
});

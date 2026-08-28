import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');

let cached: SqliteModule | null = null;

/**
 * Loads `node:sqlite` lazily: its "experimental feature" warning fires on module
 * load, too early for a top-level import to intercept.
 */
export function sqlite(): SqliteModule {
  if (cached) return cached;
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : String((warning as Error)?.message ?? '');
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    cached = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}

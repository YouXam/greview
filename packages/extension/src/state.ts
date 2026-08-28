import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { Callback, RepoInfo, Thread } from '@greview/protocol';
import { Cli, CliError } from './cli.ts';
import type { DocLocation } from './locate.ts';
import { threadSignature } from './render.ts';

export interface Located {
  root: string;
  thread: Thread;
}

/**
 * Which repositories are in the window and the threads each holds. A refresh
 * re-runs `greview list`, which re-anchors, so these positions are current.
 */
export class ReviewState implements vscode.Disposable {
  private readonly repos = new Map<string, RepoInfo>();
  private readonly threads = new Map<string, Thread[]>();
  private readonly hooks = new Map<string, Callback[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  private reportedFailure = false;
  private pending: Promise<void> | null = null;
  private queued = false;
  /** Signature of the last state the views were told about. */
  private fingerprint = '';
  /** Whether resolved threads are shown. Not persisted. */
  private showResolved = false;

  readonly onDidChange = this.changed.event;

  constructor(private readonly cli: Cli) {}

  dispose(): void {
    this.changed.dispose();
  }

  repoList(): RepoInfo[] {
    return [...this.repos.values()];
  }

  /** Resolves each workspace folder to its repository, skipping non-git folders. */
  async discover(): Promise<void> {
    this.repos.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      try {
        const info = await this.cli.repo(folder.uri.fsPath);
        this.repos.set(info.root, info);
      } catch (e) {
        // A workspace folder that is not a checkout is normal.
        if (e instanceof CliError && /not a git repository|not inside a git working tree/.test(e.message)) {
          continue;
        }
        this.reportFailure(e);
      }
    }
  }

  /** Longest repository root containing the path. */
  rootFor(fsPath: string): string | null {
    let best: string | null = null;
    for (const root of this.repos.keys()) {
      const inside = fsPath === root || fsPath.startsWith(`${root}/`);
      if (inside && (best === null || root.length > best.length)) best = root;
    }
    return best;
  }

  /** Coalesces bursts of refresh requests into one CLI pass. */
  async refresh(): Promise<void> {
    if (this.pending) {
      this.queued = true;
      return this.pending;
    }
    this.pending = this.doRefresh().finally(() => {
      this.pending = null;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    });
    return this.pending;
  }

  private async doRefresh(): Promise<void> {
    if (this.repos.size === 0) await this.discover();
    for (const root of this.repos.keys()) {
      try {
        this.threads.set(root, await this.cli.list(root, true));
        this.hooks.set(root, await this.cli.callbacks(root));
      } catch (e) {
        this.threads.set(root, []);
        this.hooks.set(root, []);
        this.reportFailure(e);
      }
    }
    // Most refreshes change nothing; staying silent then avoids a redraw.
    const fingerprint = [...this.threads]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([root, list]) => {
        // Hooks are in the signature too: adding one is the only change there is.
        const hooks = (this.hooks.get(root) ?? []).map((h) => `${h.name}=${h.command}`).join(',');
        return `${root} [${hooks}] ${list.map(threadSignature).join('')}`;
      })
      .join('');
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.changed.fire();
  }

  private reportFailure(e: unknown): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    const message = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(l10n.t('greview: {0}', message));
  }

  /** Re-arms the one-shot error report. */
  clearFailureLatch(): void {
    this.reportedFailure = false;
  }

  all(): Located[] {
    const out: Located[] = [];
    for (const [root, list] of this.threads) {
      for (const thread of list) out.push({ root, thread });
    }
    return out;
  }

  visible(): Located[] {
    return this.all().filter(({ thread }) => this.showResolved || thread.status === 'open');
  }

  resolvedShown(): boolean {
    return this.showResolved;
  }

  setShowResolved(value: boolean): void {
    if (this.showResolved === value) return;
    this.showResolved = value;
    this.changed.fire();
  }

  at(loc: DocLocation): Thread[] {
    return (this.threads.get(loc.root) ?? []).filter(
      (t) => t.filePath === loc.filePath && t.side === loc.side && t.target === loc.target,
    );
  }

  find(root: string, id: number): Thread | undefined {
    return (this.threads.get(root) ?? []).find((t) => t.id === id);
  }

  /** Per repository: its submit hooks, and how much is still open. */
  submitTargets(): Array<{ root: string; hooks: Callback[]; open: number; total: number }> {
    const out: Array<{ root: string; hooks: Callback[]; open: number; total: number }> = [];
    for (const root of this.repos.keys()) {
      const hooks = this.hooks.get(root) ?? [];
      if (hooks.length === 0) continue;
      const list = this.threads.get(root) ?? [];
      out.push({
        root,
        hooks,
        open: list.filter((t) => t.status === 'open').length,
        total: list.length,
      });
    }
    return out.sort((a, b) => a.root.localeCompare(b.root));
  }

  counts(): { open: number; attention: number } {
    let open = 0;
    let attention = 0;
    for (const { thread } of this.all()) {
      if (thread.status !== 'open') continue;
      open++;
      if (thread.current.drift === 'changed' || thread.current.drift === 'orphaned') attention++;
    }
    return { open, attention };
  }
}

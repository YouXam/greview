import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Cli, CliError } from './cli.ts';
import { bodyOf, Comments, type ThreadRef } from './comments.ts';
import { diffUris } from './locate.ts';
import { targetLabel, threadDescription } from './render.ts';
import { ReviewState } from './state.ts';
import { ThreadTree, type Node } from './tree.ts';

/** Collapse a burst of triggers into one pass. */
const DEBOUNCE_MS = 250;
/** Floor on how often the CLI is asked. */
const MIN_INTERVAL_MS = 800;
/**
 * Window after a refresh during which file-watch events are ignored: reading the
 * database touches its shared-memory index, which the watcher sees.
 */
const QUIET_AFTER_REFRESH_MS = 600;

/** The version sitting next to the running bundle. */
function onDiskVersion(extensionPath: string): string {
  try {
    const raw = readFileSync(join(extensionPath, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // A log channel is persisted under data/logs, readable from outside the editor.
  const log = vscode.window.createOutputChannel('greview', { log: true });
  const version = onDiskVersion(context.extensionPath);
  const claimed = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  log.info(`activated greview ${version} from ${context.extensionPath} (language ${vscode.env.language})`);
  if (claimed !== version) {
    // VS Code caches the manifest per window: `contributes` is whatever it cached,
    // however new the code is, until the window reloads.
    log.warn(
      `manifest is stale: VS Code believes this is ${claimed}. Menus, commands and ` +
        'settings come from that cached manifest; reload the window to pick up changes to them.',
    );
  }

  const cli = new Cli(context.extensionPath);
  const state = new ReviewState(cli);
  const comments = new Comments(state);
  const tree = new ThreadTree(state);
  const view = vscode.window.createTreeView('greview.threads', { treeDataProvider: tree });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'greview.focusList';

  context.subscriptions.push(log, state, comments, view, status);

  let timer: NodeJS.Timeout | undefined;
  let lastRefresh = 0;

  async function refreshNow(): Promise<void> {
    await state.refresh();
    lastRefresh = Date.now();
  }

  /**
   * Runs a repository's submit hooks unless batching is on. Only reachable from the
   * extension: an agent replying through the CLI must not notify itself.
   */
  async function fireHooksUnlessBatched(root: string): Promise<void> {
    const batch = vscode.workspace.getConfiguration('greview').get<boolean>('batchSubmit', false);
    if (batch) return;
    const target = state.submitTargets().find((t) => t.root === root);
    if (target === undefined) return;
    const results = await cli.runCallbacks(root);
    for (const r of results) {
      const outcome = r.timedOut ? 'timed out' : `exit ${r.code ?? r.signal ?? '?'}`;
      log.info(`hook ${r.name} (${r.command}): ${outcome} in ${r.durationMs}ms`);
      if (r.stderr) log.info(`  stderr: ${r.stderr}`);
    }
    const failed = results.filter((r) => r.code !== 0);
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        l10n.t(
          '{0} of {1} submit hook(s) failed: {2}. See the greview output for details.',
          failed.length,
          results.length,
          failed.map((r) => r.name).join(', '),
        ),
      );
    }
  }

  function scheduleRefresh(source: 'watcher' | 'editor'): void {
    const now = Date.now();
    if (source === 'watcher' && now - lastRefresh < QUIET_AFTER_REFRESH_MS) return;
    const wait = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - (now - lastRefresh));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refreshNow();
    }, wait);
  }

  state.onDidChange(() => {
    comments.render();
    tree.refresh();
    updateStatus();
  });

  function setShowResolved(value: boolean): void {
    state.setShowResolved(value);
    void vscode.commands.executeCommand('setContext', 'greview.showResolved', value);
  }

  let statusText = '';
  let badgeValue = -1;
  function updateStatus(): void {
    const enabled = vscode.workspace.getConfiguration('greview').get<boolean>('statusBar', true);
    const { open, attention } = state.counts();
    if (badgeValue !== open) {
      badgeValue = open;
      view.badge = open === 0 ? undefined : { value: open, tooltip: l10n.t('{0} open review comments', open) };
    }
    if (!enabled || open === 0) {
      statusText = '';
      status.hide();
      return;
    }
    const text =
      attention > 0
        ? `$(comment-discussion) ${open} $(warning) ${attention}`
        : `$(comment-discussion) ${open}`;
    if (text !== statusText) {
      statusText = text;
      status.text = text;
    }
    status.tooltip =
      attention > 0
        ? l10n.t('{0} open review comments; {1} sit on code that changed since', open, attention)
        : l10n.t('{0} open review comments', open);
    status.backgroundColor =
      attention > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.show();
  }

  /** Watches each repository's git dir: the database, plus the index and HEAD. */
  const watchers: FSWatcher[] = [];
  function watchRepos(): void {
    while (watchers.length > 0) watchers.pop()?.close();
    for (const repo of state.repoList()) {
      const reviewDir = join(repo.gitDir, 'review');
      try {
        mkdirSync(reviewDir, { recursive: true });
      } catch {
        // A read-only git dir just means no live updates from the database.
      }
      for (const dir of [repo.gitDir, reviewDir]) {
        try {
          watchers.push(watch(dir, { persistent: false }, () => scheduleRefresh('watcher')));
        } catch {
          // Watching is best effort; the refresh command always works.
        }
      }
    }
  }
  context.subscriptions.push({
    dispose: () => {
      while (watchers.length > 0) watchers.pop()?.close();
      if (timer) clearTimeout(timer);
    },
  });

  function refOf(arg: unknown): ThreadRef | null {
    if (arg && typeof arg === 'object' && 'kind' in arg && (arg as Node).kind === 'thread') {
      const node = arg as Extract<Node, { kind: 'thread' }>;
      return { root: node.root, id: node.thread.id };
    }
    if (arg && typeof arg === 'object' && 'uri' in arg) {
      return comments.refOf(arg as vscode.CommentThread) ?? null;
    }
    return null;
  }

  function asAction(arg: unknown): Extract<Node, { kind: 'action' }> | null {
    return arg && typeof arg === 'object' && 'kind' in arg && (arg as Node).kind === 'action'
      ? (arg as Extract<Node, { kind: 'action' }>)
      : null;
  }

  /**
   * Maps a comment VS Code handed back to our own object. The argument is a copy:
   * plain fields are trustworthy, identity and getters are not.
   */
  function ownComment(arg: unknown): ReturnType<Comments['findItem']> {
    const c = arg as { root?: unknown; threadId?: unknown; commentId?: unknown } | null;
    if (typeof c?.root !== 'string' || typeof c.threadId !== 'number' || typeof c.commentId !== 'number') {
      return null;
    }
    return comments.findItem(c.root, c.threadId, c.commentId);
  }

  async function guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      state.clearFailureLatch();
    } catch (e) {
      const message = e instanceof CliError || e instanceof Error ? e.message : String(e);
      log.error(message);
      void vscode.window.showErrorMessage(l10n.t('greview: {0}', message));
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('greview.createThread', (reply: vscode.CommentReply) =>
      guard(async () => {
        const loc = comments.locateUri(reply.thread.uri);
        if (loc === null) {
          void vscode.window.showWarningMessage(
            l10n.t(
              'greview: this editor is not a working-tree or staged diff, so there is nothing to anchor a comment to.',
            ),
          );
          return;
        }
        const range = Comments.newThreadRange(reply.thread.range);
        if (range === null) {
          void vscode.window.showWarningMessage(l10n.t('greview: a comment needs a line range to anchor to.'));
          return;
        }
        const created = await cli.add(loc.root, {
          filePath: loc.filePath,
          side: loc.side,
          target: loc.target,
          start: range.start,
          end: range.end,
          body: reply.text,
        });
        reply.thread.dispose();
        await refreshNow();
        comments.expand({ root: loc.root, id: created.id });
        await fireHooksUnlessBatched(loc.root);
      }),
    ),

    vscode.commands.registerCommand('greview.replyThread', (arg: unknown) =>
      guard(async () => {
        // The widget's own box hands over a reply with text; the Reply action hands
        // over the thread.
        if (arg && typeof arg === 'object' && 'text' in arg && 'thread' in arg) {
          await vscode.commands.executeCommand('greview.createThread', arg);
          return;
        }
        if (arg && typeof arg === 'object' && 'uri' in arg) {
          const author = vscode.workspace.getConfiguration('greview').get<string>('author', '').trim();
          comments.beginReply(arg as vscode.CommentThread, author || l10n.t('You'));
        }
      }),
    ),

    vscode.commands.registerCommand('greview.submitDraft', (draft: unknown) =>
      guard(async () => {
        // The typed text exists only on the object VS Code hands over.
        const target = comments.draftTarget();
        const body = bodyOf(draft).trim();
        comments.discardDraft();
        if (target === null || body === '') return;
        await cli.reply(target.root, target.id, body);
        await refreshNow();
        await fireHooksUnlessBatched(target.root);
      }),
    ),

    vscode.commands.registerCommand('greview.discardDraft', () => comments.discardDraft()),

    vscode.commands.registerCommand('greview.editComment', (comment: unknown) => {
      const item = ownComment(comment);
      if (item === null) return;
      item.beginEdit();
      item.redraw();
    }),

    vscode.commands.registerCommand('greview.cancelComment', (comment: unknown) => {
      const item = ownComment(comment);
      if (item === null) return;
      item.cancelEdit();
      item.redraw();
    }),

    vscode.commands.registerCommand('greview.saveComment', (comment: unknown) =>
      guard(async () => {
        const item = ownComment(comment);
        if (item === null) return;
        // The edited text lives on the copy VS Code passed, not on our instance.
        const body = bodyOf(comment).trim();
        if (body === '') {
          // An emptied body would erase the comment.
          item.cancelEdit();
          item.redraw();
          return;
        }
        await cli.editComment(item.root, item.commentId, body);
        item.finishEdit();
        item.redraw();
        await refreshNow();
      }),
    ),

    vscode.commands.registerCommand('greview.resolveThread', (arg: unknown) =>
      guard(async () => {
        const ref = refOf(arg);
        if (ref === null) return;
        await cli.setResolved(ref.root, ref.id, true);
        await refreshNow();
      }),
    ),

    vscode.commands.registerCommand('greview.unresolveThread', (arg: unknown) =>
      guard(async () => {
        const ref = refOf(arg);
        if (ref === null) return;
        await cli.setResolved(ref.root, ref.id, false);
        await refreshNow();
      }),
    ),

    vscode.commands.registerCommand('greview.deleteThread', (arg: unknown) =>
      guard(async () => {
        const ref = refOf(arg);
        if (ref === null) {
          // An empty draft thread: nothing was ever stored.
          if (arg && typeof arg === 'object' && 'dispose' in arg) (arg as vscode.CommentThread).dispose();
          return;
        }
        await cli.remove(ref.root, ref.id);
        await refreshNow();
      }),
    ),

    vscode.commands.registerCommand('greview.openThread', (arg: unknown) =>
      guard(async () => {
        const ref = refOf(arg);
        if (ref === null) return;
        const thread = state.find(ref.root, ref.id);
        if (thread === undefined) return;
        const fsPath = join(ref.root, thread.filePath);
        const [left, right] = diffUris(fsPath, thread.target);
        const line = Math.max(0, (thread.current.region?.start ?? thread.anchor.start) - 1);
        await vscode.commands.executeCommand(
          'vscode.diff',
          left,
          right,
          `${basename(thread.filePath)} (${targetLabel(thread.target)})`,
          {
            selection: new vscode.Range(line, 0, line, 0),
            preview: false,
          } satisfies vscode.TextDocumentShowOptions,
        );
        comments.render();
        comments.expand(ref);
      }),
    ),

    vscode.commands.registerCommand('greview.copyRef', (arg: unknown) =>
      guard(async () => {
        const ref = refOf(arg);
        const thread = ref ? state.find(ref.root, ref.id) : undefined;
        if (thread === undefined) return;
        await vscode.env.clipboard.writeText(thread.ref);
        void vscode.window.setStatusBarMessage(l10n.t('Copied {0}', thread.ref), 2000);
      }),
    ),

    vscode.commands.registerCommand('greview.submit', (arg: unknown) =>
      guard(async () => {
        const node = asAction(arg);
        const targets = node ? [node.root] : state.submitTargets().map((t) => t.root);
        for (const root of targets) {
          const results = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: l10n.t('Running submit hooks…'),
              cancellable: false,
            },
            () => cli.runCallbacks(root),
          );
          for (const r of results) {
            const outcome = r.timedOut ? 'timed out' : `exit ${r.code ?? r.signal ?? '?'}`;
            log.info(`hook ${r.name} (${r.command}): ${outcome} in ${r.durationMs}ms`);
            if (r.stdout) log.info(`  stdout: ${r.stdout}`);
            if (r.stderr) log.info(`  stderr: ${r.stderr}`);
          }
          const failed = results.filter((r) => r.code !== 0);
          if (failed.length === 0) {
            void vscode.window.showInformationMessage(
              l10n.t('Review submitted; {0} hook(s) ran.', results.length),
            );
          } else {
            void vscode.window.showWarningMessage(
              l10n.t(
                '{0} of {1} submit hook(s) failed: {2}. See the greview output for details.',
                failed.length,
                results.length,
                failed.map((r) => r.name).join(', '),
              ),
            );
          }
        }
      }),
    ),

    vscode.commands.registerCommand('greview.clearHooks', (arg: unknown) =>
      guard(async () => {
        const node = asAction(arg);
        const targets = node ? [node.root] : state.submitTargets().map((t) => t.root);
        let removed = 0;
        for (const root of targets) removed += (await cli.clearCallbacks(root)).removed;
        await refreshNow();
        void vscode.window.showInformationMessage(l10n.t('Removed {0} submit hook(s).', removed));
      }),
    ),

    vscode.commands.registerCommand('greview.refresh', () => guard(refreshNow)),

    vscode.commands.registerCommand('greview.showResolvedThreads', () => setShowResolved(true)),
    vscode.commands.registerCommand('greview.hideResolvedThreads', () => setShowResolved(false)),

    vscode.commands.registerCommand('greview.focusList', () =>
      vscode.commands.executeCommand('greview.threads.focus'),
    ),

    vscode.commands.registerCommand('greview.diagnose', () => {
      const out = vscode.window.createOutputChannel('greview');
      out.clear();
      out.appendLine(`extension version: ${version}`);
      out.appendLine(`extension path: ${context.extensionPath}`);
      out.appendLine(`repositories: ${state.repoList().length}`);
      for (const repo of state.repoList()) {
        out.appendLine(`  ${repo.root}`);
        out.appendLine(`    git dir: ${repo.gitDir}`);
        out.appendLine(`    database: ${repo.dbPath}`);
      }
      const counts = state.counts();
      out.appendLine(`threads: ${state.all().length} total, ${counts.open} open`);
      out.appendLine(`display language: ${vscode.env.language}`);
      out.appendLine('');
      out.appendLine('list entries, as rendered:');
      for (const { thread } of state.visible()) {
        out.appendLine(`  ${thread.comments[0]?.body.split('\n')[0] ?? ''}`);
        out.appendLine(`    ${threadDescription(thread)}`);
      }
      out.appendLine('');
      out.appendLine('open diff editors:');
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
          out.appendLine(`  ${tab.label}`);
          out.appendLine(`    original: ${tab.input.original.toString()}`);
          out.appendLine(`    modified: ${tab.input.modified.toString()}`);
        }
      }
      out.appendLine('');
      out.appendLine('documents, and where each one places:');
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== 'file' && document.uri.scheme !== 'git') continue;
        const loc = comments.locateUri(document.uri);
        out.appendLine(`  ${document.uri.toString()}`);
        out.appendLine(
          loc === null
            ? '    -> not a diff greview models (no + button here)'
            : `    -> ${loc.filePath} · ${loc.side} side of the ${loc.target} diff`,
        );
      }
      out.show();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh('editor')),
    vscode.window.tabGroups.onDidChangeTabs(() => comments.render()),
    vscode.workspace.onDidOpenTextDocument(() => comments.render()),
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      guard(async () => {
        await state.discover();
        watchRepos();
        await refreshNow();
      }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('greview.cliPath')) {
        cli.reset();
        scheduleRefresh('editor');
      } else if (e.affectsConfiguration('greview')) {
        comments.render();
        tree.refresh();
        updateStatus();
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'greview.showResolved', state.resolvedShown());

  void guard(async () => {
    await state.discover();
    watchRepos();
    await refreshNow();
  });
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { Thread } from '@greview/protocol';
import { actionFor, noteText, threadDescription, tooltipFor } from './render.ts';
import type { ReviewState } from './state.ts';

export interface FileNode {
  kind: 'file';
  root: string;
  filePath: string;
  threads: Thread[];
}

export interface ThreadNode {
  kind: 'thread';
  root: string;
  thread: Thread;
}

/** A row that performs an action. */
export interface ActionNode {
  kind: 'action';
  action: 'submit' | 'clear';
  root: string;
  hookCount: number;
  openCount: number;
}

export type Node = FileNode | ThreadNode | ActionNode;

function icon(t: Thread): vscode.ThemeIcon {
  if (t.status === 'resolved') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  if (t.current.drift === 'orphaned') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  if (t.current.drift === 'changed') {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  }
  return new vscode.ThemeIcon('comment-discussion');
}

function summary(t: Thread): string {
  const first = t.comments[0]?.body.split('\n')[0] ?? l10n.t('(no text)');
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

/** Threads needing attention sort first. */
function weight(t: Thread): number {
  if (t.status === 'resolved') return 4;
  return t.current.drift === 'changed' || t.current.drift === 'orphaned' ? 1 : 3;
}

/** The Review Comments list under Source Control. */
export class ThreadTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: ReviewState) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The action row for each repository that has hooks, if it has one. */
  private actions(): ActionNode[] {
    const batch = vscode.workspace.getConfiguration('greview').get<boolean>('batchSubmit', false);
    const out: ActionNode[] = [];
    for (const { root, hooks, open, total } of this.state.submitTargets()) {
      const action = actionFor({ hooks: hooks.length, open, total, batch });
      if (action === null) continue;
      out.push({ kind: 'action', action, root, hookCount: hooks.length, openCount: open });
    }
    return out;
  }

  getChildren(element?: Node): Node[] {
    if (element === undefined) {
      const byFile = new Map<string, FileNode>();
      for (const { root, thread } of this.state.visible()) {
        const key = `${root} ${thread.filePath}`;
        const node = byFile.get(key);
        if (node) node.threads.push(thread);
        else byFile.set(key, { kind: 'file', root, filePath: thread.filePath, threads: [thread] });
      }
      const files = [...byFile.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
      return [...this.actions(), ...files];
    }
    if (element.kind === 'file') {
      return element.threads
        .slice()
        .sort((a, b) => weight(a) - weight(b) || a.id - b.id)
        .map((thread) => ({ kind: 'thread' as const, root: element.root, thread }));
    }
    return [];
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'action') {
      const submit = element.action === 'submit';
      const item = new vscode.TreeItem(
        submit ? l10n.t('Submit review') : l10n.t('Clear submit hooks'),
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `greview:${element.root}:action:${element.action}`;
      item.description = submit
        ? l10n.t('{0} open · runs {1} hook(s)', element.openCount, element.hookCount)
        : l10n.t('all resolved · {0} hook(s) still registered', element.hookCount);
      item.iconPath = new vscode.ThemeIcon(
        submit ? 'run-all' : 'clear-all',
        submit ? new vscode.ThemeColor('charts.blue') : undefined,
      );
      item.contextValue = `greview.action.${element.action}`;
      item.command = {
        command: submit ? 'greview.submit' : 'greview.clearHooks',
        title: submit ? l10n.t('Submit review') : l10n.t('Clear submit hooks'),
        arguments: [element],
      };
      return item;
    }

    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.filePath, vscode.TreeItemCollapsibleState.Expanded);
      // A stable id lets VS Code keep the node's expansion state across refreshes.
      item.id = `greview:${element.root}:${element.filePath}`;
      const unresolved = element.threads.filter((t) => t.status === 'open').length;
      item.description =
        unresolved === element.threads.length
          ? `${unresolved}`
          : `${unresolved}/${element.threads.length}`;
      // Spelled as the window spells it, so decorations (diagnostics, git
      // status) attach to the same URI the editors use.
      item.resourceUri = vscode.Uri.file(`${this.state.viewRootOf(element.root)}/${element.filePath}`);
      item.contextValue = 'greview.file';
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }

    const t = element.thread;
    const item = new vscode.TreeItem(summary(t), vscode.TreeItemCollapsibleState.None);
    item.id = `greview:${element.root}:#${t.id}`;
    item.description = threadDescription(t);
    item.tooltip = tooltipFor(t);
    item.iconPath = icon(t);
    item.accessibilityInformation = {
      label: [summary(t), ...t.current.notes.map(noteText)].join('. '),
    };
    item.contextValue = `greview.thread.${t.status === 'resolved' ? 'resolved' : 'open'}`;
    item.command = {
      command: 'greview.openThread',
      title: l10n.t('Open Thread'),
      arguments: [element],
    };
    return item;
  }
}

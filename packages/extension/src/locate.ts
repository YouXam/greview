import * as vscode from 'vscode';
import type { DiffTarget, Side } from '@greview/protocol';
import { fsPathOf, physicalPath, placementOf, refOf, relativeTo, type DiffRole } from './refs.ts';

export interface DocLocation {
  /** Working tree root of the repository the document belongs to. */
  root: string;
  /** Repo-relative path with forward slashes. */
  filePath: string;
  side: Side;
  target: DiffTarget;
}

export interface RootLookup {
  (fsPath: string): string | null;
}

/** Indexes every open diff editor by URI. */
export function diffRoles(): Map<string, DiffRole> {
  const roles = new Map<string, DiffRole>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff)) continue;
      const originalRef = refOf(input.original);
      const modifiedRef = refOf(input.modified);
      if (originalRef === null || modifiedRef === null) continue;
      roles.set(input.original.toString(), { side: 'old', otherRef: modifiedRef });
      roles.set(input.modified.toString(), { side: 'new', otherRef: originalRef });
    }
  }
  return roles;
}

/** What a document corresponds to in review terms; null when it is not a modelled diff. */
export function locate(
  uri: vscode.Uri,
  roles: Map<string, DiffRole>,
  rootFor: RootLookup,
): DocLocation | null {
  const fsPath = fsPathOf(uri);
  if (fsPath === null) return null;
  const ref = refOf(uri);
  if (ref === null) return null;
  // A workspace opened through a symlink names documents by the symlinked
  // path; roots are physical, so resolve before comparing.
  const resolved = physicalPath(fsPath);
  const root = rootFor(resolved);
  if (root === null) return null;
  const filePath = relativeTo(root, resolved);
  if (filePath === null) return null;
  const placement = placementOf(ref, roles.get(uri.toString()));
  if (placement === null) return null;
  return { root, filePath, side: placement.side, target: placement.target };
}

/** Builds the URI the git extension uses for a file at a given ref. */
export function gitUri(fsPath: string, ref: string): vscode.Uri {
  const base = vscode.Uri.file(fsPath);
  return base.with({ scheme: 'git', query: JSON.stringify({ path: fsPath, ref }) });
}

/** The (left, right) pair VS Code should open for a target. */
export function diffUris(fsPath: string, target: DiffTarget): [vscode.Uri, vscode.Uri] {
  switch (target) {
    case 'worktree':
      return [gitUri(fsPath, '~'), vscode.Uri.file(fsPath)];
    case 'index':
      return [gitUri(fsPath, 'HEAD'), gitUri(fsPath, '~')];
    case 'head':
      return [gitUri(fsPath, 'HEAD'), vscode.Uri.file(fsPath)];
  }
}

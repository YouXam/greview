import * as vscode from 'vscode';

/** The sliver of the built-in Git extension's API that is needed here. */
interface GitApi {
  getRepository(uri: vscode.Uri): unknown;
  openRepository(root: vscode.Uri): Promise<unknown>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/**
 * Content behind `git:` URIs comes from the built-in Git extension, and only for
 * repositories in its model: anything else fails as a nonexistent file. That
 * model can miss a repository this extension knows — the CLI resolves the root
 * from any workspace folder inside it, while the Git extension does not open a
 * repository above the workspace folder without being asked. So ask.
 */
export async function ensureGitRepository(root: string, file: vscode.Uri): Promise<boolean> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (extension === undefined) return false;
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = exports.getAPI(1);
    if (api.getRepository(file)) return true;
    return (await api.openRepository(vscode.Uri.file(root))) !== null;
  } catch {
    return false;
  }
}

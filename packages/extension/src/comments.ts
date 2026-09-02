import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { Comment as StoredCommentData, Thread } from '@greview/protocol';
import { diffRoles, locate, type DocLocation } from './locate.ts';
import { lastCommentableLine } from './refs.ts';
import { commentLabel, driftMarkdown, rangeFor, threadLabel, threadSignature } from './render.ts';
import type { ReviewState } from './state.ts';

export interface ThreadRef {
  root: string;
  id: number;
}

function keyOf(loc: DocLocation): string {
  return [loc.root, loc.filePath, loc.side, loc.target].join(' ');
}

function preview(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.supportThemeIcons = true;
  return md;
}

/**
 * One stored comment, as a long-lived object: VS Code drives inline editing by
 * flipping `mode` on the instance it was handed, so a refresh must reuse it.
 */
export class CommentItem implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue = 'editable';
  label: string | undefined;
  timestamp: Date;
  /** The widget this comment lives in. */
  parent: vscode.CommentThread | undefined;
  /** Raw text to restore when an edit is cancelled. */
  private saved: string;

  constructor(
    readonly root: string,
    readonly threadId: number,
    readonly commentId: number,
    thread: Thread,
    data: StoredCommentData,
  ) {
    this.saved = data.body;
    this.body = preview(data.body);
    this.author = { name: data.author };
    this.label = commentLabel(thread, data);
    this.timestamp = new Date(data.createdAt);
  }

  get text(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }

  get editing(): boolean {
    return this.mode === vscode.CommentMode.Editing;
  }

  /** Takes on new stored content, unless an edit is in progress. */
  sync(thread: Thread, data: StoredCommentData): void {
    if (this.editing) return;
    this.saved = data.body;
    this.body = preview(data.body);
    this.author = { name: data.author };
    this.label = commentLabel(thread, data);
    this.timestamp = new Date(data.createdAt);
  }

  beginEdit(): void {
    this.saved = this.text;
    // A plain string puts the markdown source in the editor, not its rendering.
    this.body = this.saved;
    this.mode = vscode.CommentMode.Editing;
  }

  cancelEdit(): void {
    this.body = preview(this.saved);
    this.mode = vscode.CommentMode.Preview;
  }

  finishEdit(): void {
    this.saved = this.text;
    this.body = preview(this.saved);
    this.mode = vscode.CommentMode.Preview;
  }

  /** Makes the widget pick up a mode change. */
  redraw(): void {
    if (this.parent) this.parent.comments = [...this.parent.comments];
  }
}

/**
 * An unsent reply. `canReply` is all or nothing, so an on-demand editor is a
 * comment in `Editing` mode that has not been written anywhere yet.
 */
export class DraftComment implements vscode.Comment {
  body: string | vscode.MarkdownString = '';
  mode = vscode.CommentMode.Editing;
  contextValue = 'draft';
  readonly author: vscode.CommentAuthorInformation;

  constructor(
    readonly root: string,
    readonly threadId: number,
    readonly parent: vscode.CommentThread,
    authorName: string,
  ) {
    this.author = { name: authorName };
  }

  get text(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }
}

interface Rendered {
  thread: vscode.CommentThread;
  signature: string;
  items: Map<number, CommentItem>;
  /** Set while a reply to this thread is being composed. */
  draft: DraftComment | null;
}

/**
 * Keeps VS Code comment threads in step with the database. Reassigning `comments`
 * redraws the widget, so an unchanged thread is left untouched.
 */
/** Reads a comment body without assuming it is still our own object. */
export function bodyOf(comment: unknown): string {
  const body = (comment as { body?: unknown } | null)?.body;
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object' && 'value' in body) {
    return String((body as { value: unknown }).value);
  }
  return '';
}

export class Comments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly rendered = new Map<string, Rendered>();
  private readonly refs = new Map<vscode.CommentThread, ThreadRef>();

  constructor(private readonly state: ReviewState) {
    this.controller = vscode.comments.createCommentController('greview', l10n.t('Review Comments'));
    this.controller.options = {
      prompt: l10n.t('Leave a review comment on these lines'),
      placeHolder: l10n.t('What is wrong here?'),
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentableRanges(document),
    };
  }

  dispose(): void {
    for (const entry of this.rendered.values()) entry.thread.dispose();
    this.rendered.clear();
    this.refs.clear();
    this.controller.dispose();
  }

  refOf(thread: vscode.CommentThread): ThreadRef | undefined {
    return this.refs.get(thread);
  }

  /** Where a thread can be started: any diff side this tool models. */
  private commentableRanges(document: vscode.TextDocument): vscode.Range[] {
    const loc = locate(document.uri, diffRoles(), (p) => this.state.rootFor(p));
    if (loc === null) return [];
    const last = lastCommentableLine(document);
    if (last === null) return [];
    const mode = vscode.workspace
      .getConfiguration('greview')
      .get<string>('commentableLines', 'anywhere');
    if (mode === 'changed-only') {
      // Lines already carrying a thread stay commentable even once the hunk collapses.
      const existing = this.state.at(loc).map((t) => rangeFor(t));
      if (existing.length > 0) return existing;
    }
    return [new vscode.Range(0, 0, last, 0)];
  }

  /** Finds every open document each stored thread should appear in. */
  private documentsByLocation(): Map<string, vscode.Uri[]> {
    const roles = diffRoles();
    const out = new Map<string, vscode.Uri[]>();
    for (const document of vscode.workspace.textDocuments) {
      const loc = locate(document.uri, roles, (p) => this.state.rootFor(p));
      if (loc === null) continue;
      const key = keyOf(loc);
      const list = out.get(key);
      if (list) list.push(document.uri);
      else out.set(key, [document.uri]);
    }
    return out;
  }

  render(): void {
    const byLocation = this.documentsByLocation();
    const live = new Set<string>();

    for (const { root, thread } of this.state.visible()) {
      const uris = byLocation.get([root, thread.filePath, thread.side, thread.target].join(' '));
      if (!uris) continue;
      const signature = threadSignature(thread);
      for (const uri of uris) {
        const key = `${root} ${thread.id} ${uri.toString()}`;
        live.add(key);
        const existing = this.rendered.get(key);
        if (existing) {
          if (existing.signature === signature) continue;
          this.update(existing, root, thread);
          existing.signature = signature;
        } else {
          const entry: Rendered = {
            thread: this.controller.createCommentThread(uri, rangeFor(thread), []),
            signature,
            items: new Map(),
            draft: null,
          };
          // Only threads that need a decision open themselves.
          entry.thread.collapsibleState =
            thread.status === 'open' && thread.current.drift !== 'current'
              ? vscode.CommentThreadCollapsibleState.Expanded
              : vscode.CommentThreadCollapsibleState.Collapsed;
          this.update(entry, root, thread);
          this.rendered.set(key, entry);
          this.refs.set(entry.thread, { root, id: thread.id });
        }
      }
    }

    for (const [key, entry] of this.rendered) {
      if (live.has(key)) continue;
      this.refs.delete(entry.thread);
      entry.thread.dispose();
      this.rendered.delete(key);
    }
  }

  private update(entry: Rendered, root: string, thread: Thread): void {
    const target = entry.thread;
    const next = rangeFor(thread);
    if (target.range === undefined || !target.range.isEqual(next)) target.range = next;
    target.label = threadLabel(thread);
    target.contextValue = thread.status === 'resolved' ? 'resolved' : 'open';
    target.state =
      thread.status === 'resolved'
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    // Replies come from the Reply action, which adds a draft comment.
    target.canReply = false;

    const comments: vscode.Comment[] = [];
    const drift = driftMarkdown(thread);
    if (drift) {
      comments.push({
        author: { name: 'greview' },
        body: drift,
        mode: vscode.CommentMode.Preview,
        contextValue: 'drift',
        label: l10n.t('since this comment'),
      });
    }
    const stale = new Set(entry.items.keys());
    for (const data of thread.comments) {
      stale.delete(data.id);
      let item = entry.items.get(data.id);
      if (item) {
        item.sync(thread, data);
      } else {
        item = new CommentItem(root, thread.id, data.id, thread, data);
        entry.items.set(data.id, item);
      }
      item.parent = target;
      comments.push(item);
    }
    for (const id of stale) entry.items.delete(id);
    // A draft in progress outlives a redraw.
    if (entry.draft) comments.push(entry.draft);
    target.comments = comments;
  }

  /**
   * The entry holding the reply being composed, found by scanning rather than
   * remembered: a disposed thread leaves `rendered`, so its draft cannot be reached
   * afterwards. VS Code passes commands a copy of the comment, so the draft object
   * itself is never a usable handle.
   */
  private openDraft(): Rendered | null {
    for (const entry of this.rendered.values()) {
      if (entry.draft !== null) return entry;
    }
    return null;
  }

  /** Opens an editor under a thread; at most one draft exists at a time. */
  beginReply(thread: vscode.CommentThread, authorName: string): void {
    const entry = this.entryFor(thread);
    const ref = this.refs.get(thread);
    if (entry === null || ref === undefined || entry.draft !== null) return;
    this.discardDraft();
    entry.draft = new DraftComment(ref.root, ref.id, thread, authorName);
    thread.comments = [...thread.comments, entry.draft];
  }

  /** Which thread the open draft belongs to, if any. */
  draftTarget(): ThreadRef | null {
    const draft = this.openDraft()?.draft ?? null;
    return draft === null ? null : { root: draft.root, id: draft.threadId };
  }

  /** Removes the open draft, by marker: identity is not comparable here. */
  discardDraft(): void {
    const entry = this.openDraft();
    if (entry === null) return;
    entry.draft = null;
    entry.thread.comments = entry.thread.comments.filter((c) => c.contextValue !== 'draft');
  }

  /** Locates one of our comment objects from the plain fields on a copy of it. */
  findItem(root: string, threadId: number, commentId: number): CommentItem | null {
    for (const entry of this.rendered.values()) {
      const item = entry.items.get(commentId);
      if (item && item.root === root && item.threadId === threadId) return item;
    }
    return null;
  }

  private entryFor(thread: vscode.CommentThread): Rendered | null {
    for (const entry of this.rendered.values()) {
      if (entry.thread === thread) return entry;
    }
    return null;
  }

  /**
   * The line range for a brand-new thread; null when the widget carries none. A
   * selection ending at column 0 does not claim the following line.
   */
  static newThreadRange(range: vscode.Range | undefined): { start: number; end: number } | null {
    if (range === undefined) return null;
    let endLine = range.end.line;
    if (endLine > range.start.line && range.end.character === 0) endLine -= 1;
    return { start: range.start.line + 1, end: endLine + 1 };
  }

  locateUri(uri: vscode.Uri): DocLocation | null {
    return locate(uri, diffRoles(), (p) => this.state.rootFor(p));
  }

  /** Expands a thread's widget. */
  expand(ref: ThreadRef): void {
    for (const [thread, candidate] of this.refs) {
      if (candidate.root === ref.root && candidate.id === ref.id) {
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
    }
  }
}

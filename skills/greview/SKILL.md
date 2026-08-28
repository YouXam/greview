---
name: greview
description: Read and answer human code-review comments left on git diff hunks. Load when the user mentions review comments, review threads, "看一下 review", unresolved comments, greview, or asks you to address feedback left in VS Code on a working-tree or staged diff. Also load before declaring a review-driven task finished, to check nothing is left unresolved.
---

# greview — review threads on git diffs

The user reviews diffs in VS Code and leaves comments on individual hunks, like a
GitLab merge-request thread but against the **working tree** and **index** rather
than a commit. `greview` is how you read and answer those threads from the command
line.

Threads are the user's, not yours. Your job is to read them, fix what they point
at, and reply. **Never resolve a thread** — see [Rules](#rules).

## Finding out whether there is anything to do

```sh
greview list --json          # open threads, freshly re-anchored
greview stats --json         # {"open":3,"resolved":1,"changed":1,"orphaned":0}
```

Run this at the start of any task the user framed as "address the review", and
again before you report the task finished.

Everything accepts `--json`, and every JSON response is `{"ok":true,"data":...}`
or `{"ok":false,"error":"..."}`. Check `ok` before reading `data`.

`greview` must run inside the repository. In a multi-worktree setup each worktree
has **its own database** — a thread written in one worktree is invisible from
another. Pass `--cwd <dir>` when you are not already in the right one.

## Reading a thread

```sh
greview show 3 --json
```

The fields that matter:

| Field | Meaning |
| --- | --- |
| `ref` | `path:start-end` at **currently valid** line numbers — use this to open the code |
| `comments[]` | The conversation, oldest first; `authorKind` is `human` or `agent` |
| `anchor.lines` | The exact lines as they were when the comment was written |
| `current.drift` | What became of those lines — see below |
| `current.region.lines` | What stands in their place now |
| `current.notes` | What changed, as `{code, text, args}` — read `code`, show `text` |
| `target` | Which diff: `worktree` (unstaged), `index` (staged), `head` (all pending) |
| `side` | `new` for added/current lines, `old` for removed lines |

Trust `ref` and `current.region`. Do not compute positions from `anchor` — the
file has probably moved on since the comment was written, and the anchor is
deliberately a historical record.

### Drift: what happened to the commented lines

- **`current`** — still there, same place. The comment applies as written.
- **`moved`** — still there verbatim, different line numbers. Applies as written;
  use `current.region.start`.
- **`changed`** — the lines were edited or deleted after the comment. Read
  `anchor.lines` (what they objected to) against `current.region.lines` (what is
  there now) before acting. Often somebody already fixed it — say so in a reply
  instead of changing it again.
- **`orphaned`** — the file is gone from that version. Ask; do not guess.

`current.notes` also reports movement between versions. Each note is an object:
`code` is stable and worth branching on, `text` is English prose you can quote.
`{"code":"staged"}` means the exact lines commented on have been staged;
`{"code":"replacement-staged"}` means the rewrite has. Staging is a strong hint
that the user accepts the current state — but it is a hint, not a resolution.

## Replying

Reply once you have acted, and say concretely what you did:

```sh
greview reply 3 --agent -m "Wrapped the parse in a try/catch and return 400 on \
malformed bodies. src/handler.ts:41-48."
```

- **Sign with your own name, never the user's.** `greview` refuses to attribute an
  agent comment to `git config user.name` — that is the reviewer's identity, and a
  machine comment wearing it is indistinguishable from one they wrote. It infers a
  name from `$AI_AGENT` or `$CLAUDECODE` when it can; if it cannot, it tells you to
  pass `--author`. Give a stable, recognisable name for your kind, for example
  `--author claude-code` or `--author codex`.
- `--agent` marks the comment as machine-written. It is implied when `$AI_AGENT` or
  `$CLAUDECODE` is set, so you usually get it for free — pass it anyway when in
  doubt, it is never wrong.
- `-m -` reads the body from stdin, for anything multi-line.
- To correct something you already wrote, `greview edit <comment-id> -m ...`
  rather than piling on a second reply. Comment ids are `comments[].id` from
  `show --json`; an edited comment is marked as edited, so this is not a way to
  quietly rewrite history.
- Reference `file:line` so the user can jump straight there.
- If you disagree, reply with the reasoning and leave the thread open. A reply is
  not a resolution; the user decides.

## Commenting

You normally should not — review is the human's job. Two cases where it is
appropriate:

1. The user explicitly asks you to review a diff and record findings.
2. You need to flag something for the user on a specific line and they asked to
   be flagged that way.

```sh
greview add --file src/handler.ts --line 41-48 --target worktree --agent \
  -m "This swallows the error; the caller cannot tell a 400 from a 500."
```

`--line` is in the **current** content of whichever version `--target`/`--side`
select, so read the file first and use the line numbers you just saw.
`--target index` comments on the staged diff, `--target worktree` on the unstaged
one (the default).

## Rules

- **Never run `greview resolve`.** Only the human decides that a concern is
  settled; resolving for them destroys the signal they use to review your work.
  This holds even when you are certain you fixed it — reply and move on.
- **Never run `greview rm`.** Deleting somebody's review comment loses it.
- **Only edit comments you wrote.** `greview edit` can rewrite any comment,
  including the reviewer's; putting words in their mouth is worse than being
  wrong. Check `authorKind` is `agent` and the author is you before editing.
- Do not edit greview's internal data directly; anchoring and drift detection live
  in the CLI.
- Leaving a thread open is the correct outcome for anything you could not fix,
  disagreed with, or want the user to look at. Say which in the reply.

## Command reference

```
greview list [--all|--resolved] [--file P] [--target T] [--events]   list threads
greview show <id>                                    one thread, with history
greview add --file P --line N[-M] -m TEXT            start a thread
greview reply <id> -m TEXT                           add a comment
greview edit <comment-id> -m TEXT                    rewrite one of your comments
greview sync                                         re-anchor everything now
greview stats                                        counts
greview repo                                         root, git dir, db path
greview install-skill                                install this agent skill
greview onsubmit list                                commands run when the user
                                                     presses Submit in the panel
```

Shared flags: `--json`, `--cwd <dir>`, `--author <name>`, `--agent`.
`greview list` and `greview show` re-anchor before answering, so their positions
are always fresh; `--no-sync` skips that and reports the last known state.

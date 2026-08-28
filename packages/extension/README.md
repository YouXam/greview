# greview

Review working-tree and staged diffs with coding agents.

Open a changed file from Source Control, hover beside a line in the diff, and
click `+` to start a review thread. Both sides of the diff are supported,
including removed lines.

The **Review Comments** view groups threads by file and puts changed code first.
Use it to open, reply to, resolve, reopen, or delete a thread. The status bar
shows the number of open threads.

Threads follow unchanged code when it moves. When reviewed lines are edited,
greview shows the original and current text so the reviewer can decide whether
the comment is resolved.

Coding agents use the companion CLI:

```sh
npm install --global greview-cli
greview list --json
```

Install the agent skill:

```sh
greview setup skill
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `greview.cliPath` | `""` | Explicit CLI path; empty uses PATH, then the bundled CLI |
| `greview.author` | `""` | Comment author; empty uses `git config user.name` |
| `greview.statusBar` | `true` | Show the open-thread count |
| `greview.batchSubmit` | `false` | Run submit hooks only after **Submit Review** |
| `greview.commentableLines` | `anywhere` | Restrict the gutter action to changed lines if desired |

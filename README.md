# greview

Review local Git diffs with humans in VS Code and coding agents on the command
line.

The VS Code extension adds review threads to working-tree and staged diffs. The
CLI gives agents the same thread list, current code locations, conversation, and
reply flow. Threads follow code as lines move and show a before/after view when
the reviewed code changes. Only the reviewer decides when a thread is resolved.

## Install

Install the CLI:

```sh
npm install --global greview-cli
```

Then choose the VS Code extension, agent skill, or both:

```sh
greview setup
```

You can also install [greview from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=youxam.greview)
directly, or search for `greview` in the Extensions view.

## Use in VS Code

1. Open a changed file from Source Control.
2. Hover beside a line in the diff and click `+`.
3. Write a review comment.
4. Use **Review Comments** in Source Control to revisit, reply, reopen, or resolve
   threads.

Comments can target the working tree, the index, or the complete pending diff.
Both sides of a diff are supported, including removed lines.

## Use from the CLI

```sh
greview list
greview show 3
greview reply 3 --agent --author codex -m "Handled the empty input case."
greview stats
greview setup skill
greview setup extension
```

Every command supports `--json` for agent integrations. Run `greview help` for
the complete command reference.

## Develop

Requirements: Node.js 22.5 or newer and pnpm 11.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm package
```

`pnpm package` creates `packages/extension/greview.vsix`. To install the CLI from
this checkout, run `pnpm install:cli`.

## License

MIT

# greview CLI

Read and reply to review comments attached to local Git diffs.

## Install

```sh
npm install --global greview-cli
```

The npm package is named `greview-cli`; it installs the `greview` command.

Install the companion agent skill:

```sh
greview install-skill
```

## Quick start

```sh
greview list
greview show 1
greview reply 1 --agent --author codex -m "Updated the validation."
greview stats
```

Run `greview help` for every command and option.

# greview CLI

Read and reply to review comments attached to local Git diffs.

## Install

```sh
npm install --global greview-cli
```

The npm package is named `greview-cli`; it installs the `greview` command. Run
the guided setup to install the VS Code extension, agent skill, or both:

```sh
greview setup
```

Install one component directly:

```sh
greview setup skill
greview setup extension
```

## Quick start

```sh
greview list
greview show 1
greview reply 1 --agent --author codex -m "Updated the validation."
greview stats
```

Run `greview help` for every command and option.

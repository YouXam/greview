const SKILL_URL = 'https://github.com/YouXam/greview/tree/main/skills/greview';

export function globalHelp(version: string): string {
  return `greview ${version} - review local Git diffs with humans and coding agents

Usage:
  greview <command> [options]
  greview help <command>

Review threads:
  list                     List open threads
  show <id>                Show a thread, its comments, and current location
  add                      Start a thread on a line range
  reply <id>               Reply to a thread
  edit <comment-id>        Edit a comment
  resolve <id>             Resolve a thread
  unresolve <id>           Reopen a thread
  rm <id>                  Delete a thread

Repository:
  sync                     Re-anchor all threads
  stats                    Show thread counts
  repo                     Show repository details

Setup and integrations:
  setup [skill|extension]  Install greview components
  onsubmit <command>       Manage review submission hooks

Help:
  help [command]           Show global or command-specific help
  version                  Print the greview version

Global options:
  --cwd <dir>              Run as if started in this directory
  --json                   Emit {"ok":true,"data":...} responses
  -h, --help               Show help for the selected command
  -v, --version            Print the greview version

Agent skill:
  Guide:   ${SKILL_URL}
  Install: greview setup skill
  Direct:  npx --yes skills add YouXam/greview --skill greview

Run \`greview help <command>\` for command options and examples.
`;
}

const HELP: Record<string, string> = {
  list: `Usage:
  greview list [options]

List review threads, freshly re-anchored against the current repository state.
Open threads are shown by default, with changed or orphaned threads first.

Options:
  --all                    Include open and resolved threads
  --resolved               Show only resolved threads
  --file <path>            Restrict results to one file
  --target <target>        Restrict to worktree, index, or head
  --events                 Include event history in JSON output
  --no-sync                Use the last recorded locations
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Examples:
  greview list
  greview list --file src/api.ts --json
  greview list --resolved --no-sync
`,

  show: `Usage:
  greview show <thread-id> [options]

Show one thread with its comments, original anchor, current region, drift notes,
and event history. The thread is re-anchored before display by default.

Options:
  --no-sync                Use the last recorded location
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Examples:
  greview show 3
  greview show 3 --json
`,

  add: `Usage:
  greview add --file <path> --line <n|n-m> -m <text> [options]

Start a review thread on lines in a local Git diff.

Required:
  --file <path>            Repository-relative or local file path
  --line <n|n-m>           One line or an inclusive line range
  -m, --message <text>     Comment text; use - to read stdin

Options:
  --side <side>            new or old (default: new)
  --target <target>        worktree, index, or head (default: worktree)
  --author <name>          Comment author
  --agent                  Mark the author as a coding agent
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Examples:
  greview add --file src/api.ts --line 41-48 -m "Handle malformed input"
  greview add --file src/api.ts --line 12 --target index --side old -m -
`,

  reply: `Usage:
  greview reply <thread-id> -m <text> [options]

Add a comment to an existing review thread. Replying does not resolve it.

Options:
  -m, --message <text>     Comment text; use - to read stdin
  --author <name>          Comment author
  --agent                  Mark the author as a coding agent
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Examples:
  greview reply 3 --agent --author codex -m "Added input validation."
  printf 'Detailed reply\n' | greview reply 3 -m -
`,

  edit: `Usage:
  greview edit <comment-id> -m <text> [options]

Replace the body of an existing comment. Comment IDs are shown by
\`greview show <thread-id> --json\`.

Options:
  -m, --message <text>     Replacement text; use - to read stdin
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview edit 7 -m "Corrected reply text."
`,

  resolve: `Usage:
  greview resolve <thread-id> [options]

Mark a review thread as resolved. Resolution is a human review decision; coding
agents should reply to threads and leave resolution to the reviewer.

Options:
  --author <name>          Person recording the decision
  --by <name>              Explicit resolution attribution
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview resolve 3
`,

  unresolve: `Usage:
  greview unresolve <thread-id> [options]

Reopen a resolved review thread.

Options:
  --author <name>          Person recording the decision
  --by <name>              Explicit attribution
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview unresolve 3
`,

  rm: `Usage:
  greview rm <thread-id> [options]

Permanently delete a thread and all of its comments. Coding agents should never
delete review threads on behalf of the reviewer.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview rm 3
`,

  sync: `Usage:
  greview sync [options]

Re-anchor every thread against the current worktree, index, and HEAD, then record
any drift or location changes.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview sync --json
`,

  stats: `Usage:
  greview stats [options]

Show counts for open, resolved, changed, and orphaned threads. Locations are
refreshed before counting.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview stats --json
`,

  repo: `Usage:
  greview repo [options]

Show the repository root, Git directory, current branch, HEAD commit, and greview
data path.

Options:
  --cwd <dir>              Start discovery from another directory
  --json                   Emit machine-readable output

Example:
  greview repo --cwd ../another-checkout
`,

  setup: `Usage:
  greview setup
  greview setup skill
  greview setup extension

Install greview components. With no component, choose the agent skill, VS Code
extension, or both interactively. Setup does not require a Git repository.

Components:
  skill                    Run the interactive skills CLI installer
  extension                Install youxam.greview from the VS Code Marketplace

Requirements:
  skill                    Node.js with npm/npx
  extension                The VS Code \`code\` command on PATH

Examples:
  greview setup
  greview setup skill
  greview setup extension
`,

  'setup:skill': `Usage:
  greview setup skill

Install the greview agent skill from GitHub. This starts the skills CLI and keeps
its interactive choice of project/global scope and target agents.

Requirements:
  Node.js with npm/npx

Equivalent command:
  npx --yes skills add YouXam/greview --skill greview
`,

  'setup:extension': `Usage:
  greview setup extension

Install the greview extension from the VS Code Marketplace by running:
  code --install-extension youxam.greview

Requirement:
  The VS Code \`code\` command must be available on PATH.

Marketplace:
  https://marketplace.visualstudio.com/items?itemName=youxam.greview
`,

  onsubmit: `Usage:
  greview onsubmit <command> [arguments] [options]

Manage commands that run when a review is submitted. Hooks belong to the current
worktree, run concurrently through the shell, and receive no arguments.

Commands:
  list                     List hooks
  add <name> <command>     Add or replace a hook
  delete <name>            Delete one hook
  clear                    Delete all hooks
  run                      Run all hooks now

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Examples:
  greview onsubmit list
  greview help onsubmit add
`,

  'onsubmit:list': `Usage:
  greview onsubmit list [options]

List review submission hooks configured for the current worktree.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview onsubmit list --json
`,

  'onsubmit:add': `Usage:
  greview onsubmit add <name> <command> [options]

Add a review submission hook, or replace the hook with the same name. The command
runs through the shell at the repository root and receives no arguments.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview onsubmit add notify "./scripts/notify-review.sh"
`,

  'onsubmit:delete': `Usage:
  greview onsubmit delete <name> [options]

Delete one review submission hook from the current worktree.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview onsubmit delete notify
`,

  'onsubmit:clear': `Usage:
  greview onsubmit clear [options]

Delete every review submission hook from the current worktree.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable output

Example:
  greview onsubmit clear
`,

  'onsubmit:run': `Usage:
  greview onsubmit run [options]

Run all review submission hooks concurrently. Each hook has a one-minute timeout;
the command exits non-zero if any hook fails.

Options:
  --cwd <dir>              Run against another checkout
  --json                   Emit machine-readable hook results

Example:
  greview onsubmit run --json
`,

  help: `Usage:
  greview help [command]
  greview <command> --help

Show global help or detailed help for a command. Nested onsubmit commands also
have their own pages.

Examples:
  greview help add
  greview list --help
  greview help onsubmit add
`,

  version: `Usage:
  greview version
  greview --version

Print the installed greview CLI version.
`,
};

const ALIASES: Record<string, string> = {
  ls: 'list',
  delete: 'rm',
  reopen: 'unresolve',
};

const ONSUBMIT_ALIASES: Record<string, string> = {
  rm: 'delete',
};

export function commandHelp(parts: string[]): string | null {
  const rawCommand = parts[0];
  if (rawCommand === undefined) return null;
  const command = ALIASES[rawCommand] ?? rawCommand;
  if (command === 'setup') {
    const component = parts[1];
    return component === undefined ? (HELP.setup ?? null) : (HELP[`setup:${component}`] ?? null);
  }
  if (command !== 'onsubmit') return HELP[command] ?? null;

  const rawSubcommand = parts[1];
  if (rawSubcommand === undefined) return HELP.onsubmit ?? null;
  const subcommand = ONSUBMIT_ALIASES[rawSubcommand] ?? rawSubcommand;
  return HELP[`onsubmit:${subcommand}`] ?? null;
}

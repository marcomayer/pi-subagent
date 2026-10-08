# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own [herdr](https://github.com/ogulcancelik/herdr) pane with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or focus the child's pane.

The first subagent opens to the right of the parent's pane; later ones stack below it, and the column is kept at equal heights. Concurrent spawns coordinate pane creation and resizing across processes; the agents themselves still work concurrently. Children inherit the spawning process's environment, including variables loaded by direnv.

## Requirements

- Pi, running inside a herdr pane
- herdr 0.8.2 or newer
- Node.js 22.19 or newer

## Install

Clone into Pi's global extension directory, expose the CLI on `PATH`, and link the bundled herdr plugin, which starts each child without typing into a shell:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
herdr plugin link ~/.pi/agent/extensions/subagent/herdr-plugin
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select an active child and focus its pane. The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.

## Development

Run `npm test` with Node.js 22.19 or newer. The tests exercise concurrent CLI spawns against a mock Herdr socket, plus cross-process locking, crash recovery, and bounded waiting. Parent lifecycle tests use a simulated Pi host and clock to verify capped layout retry backoff. They do not open terminal panes or launch Pi agents.

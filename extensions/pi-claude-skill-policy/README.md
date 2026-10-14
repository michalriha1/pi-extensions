# Claude skill policy for Pi

Read-only adapter for Claude Code `skillOverrides`, targeting **Pi 1.2.0**.
No settings UI, policy writes, skill-file edits, resource loaders, or extension
execution. Pi remains responsible for discovering and expanding skills.

Load explicitly (or install this directory as a Pi package):

```sh
pi --extension ./extensions/pi-claude-skill-policy/index.ts
```

## Settings

Only `skillOverrides` is interpreted. Example `~/.claude/settings.json`:

```json
{
  "skillOverrides": {
    "review": "on",
    "pdf": "name-only",
    "deploy": "user-invocable-only",
    "legacy": "off"
  }
}
```

| Value | Model discovery | Explicit `/skill:name` |
| --- | --- | --- |
| `on` / missing | Native name, description, path | Native expansion |
| `name-only` | Name and **Pi's existing path**, empty description text | Native expansion |
| `user-invocable-only` | Omitted | Native expansion |
| `off` | Omitted | Input handled/blocked before expansion |

Pi's formatter still emits an empty `<description>` element for `name-only`.
Native `disableModelInvocation` is never relaxed, even by `on`.
Names are exact, case-sensitive **Pi skill names**, not paths or aliases.
Overrides cannot add skills Pi did not load.

### Paths, precedence, trust

Read in order, merging **per skill** (later entries win):

1. `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` when unset.
2. `<ctx.cwd>/.claude/settings.json`, only if `ctx.isProjectTrusted() === true`.
3. `<ctx.cwd>/.claude/settings.local.json`, under the same trust gate.

Project root deliberately means **Pi's context working directory**, not the Git
root. No ancestor search, Git commands, Claude trust-file interpretation, or
implicit trust grant. Starting Pi in a subdirectory reads only that subdirectory's
project settings. This matches the scope of Pi's project `.pi` settings and avoids
using a cwd trust decision to authorize parent config. Relative
`CLAUDE_CONFIG_DIR` resolves against the process working directory; no tilde or
environment interpolation is performed.

The installed public `ExtensionContext.isProjectTrusted()` API is wired by Pi to
its settings manager. This adapter accepts that host decision (including host
CLI/SDK trust defaults); it does not independently prove user consent. If the API
is absent or does not return literal `true`, **only global settings apply**.
Untrusted project files are not read, and cannot relax or override global policy.
Trusted project overrides can intentionally relax global settings.

### Refresh and validation

Files are reread on every `input` and `before_agent_start` event; no `/reload`
needed for policy changes. The latter changes only the host-provided
`systemPromptOptions.skills`, never replaces the whole prompt. This is a run-start
refresh, **not** a refresh before every internal tool/model continuation. Edits
cannot retroactively undo a skill expansion already queued or erase instructions
already in conversation history.

The JSON root must be an object; `skillOverrides`, when present, must be an object
mapping nonempty names to exactly the four strings above. Invalid JSON/schema or
read errors retain that file's last successfully read policy in this extension
runtime. Initially malformed files have no policy to retain and contribute nothing.
Missing files or a missing field intentionally clear that layer. Invalid layers
are rejected atomically; unrelated settings are ignored. Warnings go to stderr,
without dumping settings contents; repeated identical failures are suppressed
until recovery. No last-good state survives process restart or `/reload`.

## Deliberate limits

- This is discovery/command policy, **not an access-control sandbox**. Tools can
  still read any accessible skill file; existing context can still mention it.
- No parity claim for Claude managed settings, CLI overrides, plugin settings,
  plugin-qualified identity resolution, or other Claude configuration sources.
- No autocomplete mutation: disabled skills may remain listed in Pi's command
  picker/startup listing, but their native explicit command is blocked on input.
- Command matching follows Pi 1.2.0 exactly: `/skill:` at character zero, name
  ending at the first literal space (not a tab/newline), no trimming. Prefixes
  such as `/skill:legacy-extra` are not blocked by `legacy`.
- Other extensions are trusted code. Earlier registered extension commands can
  run before input interception; later input handlers can rewrite commands after
  this check. Prompt templates, custom execution paths bypassing input, or forced
  prompts from another extension are outside the adapter's enforcement contract.
- Normal missing-key discovery requires Pi to supply fresh native skills each
  run, as Pi 1.2.0 does. This adapter does not reload resources or undo another
  extension's filtering. Changes to skill files themselves still require Pi reload.

## Tests

```sh
cd extensions/pi-claude-skill-policy
npm test
npm run typecheck  # with peer/dev dependencies installed
```

Tests use Node's built-in test runner/type stripping (Node 22.18+), mock only the
host event registration/context, and use the **installed Pi renderer**. They never
load project extensions. `PI_TEST_RUNTIME` can point to an installed coding-agent
package directory; default is this workstation's Pi 1.2.0 release directory.
Coverage: four states, default, native manual-only, schema, merge precedence,
trust denial/missing API, cwd boundaries, live edits, malformed last-good/recovery,
deletion, explicit command boundaries, structured prompt preservation.

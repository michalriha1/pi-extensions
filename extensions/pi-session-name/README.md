# pi-session-name

Displays the current session name in the editor border and exposes the model tool
`rename_session` in all modes. No default names or automatic startup renaming.

## Usage

Ask the assistant to rename the current session, or invoke `/skill:rename-session`
when that user skill is installed. The tool accepts:

```json
{ "name": "Workday 2026-09-15" }
```

Names are trimmed, must be nonblank and at most 200 Unicode characters, and may
not contain control characters or line breaks. The tool calls `pi.setSessionName`,
verifies `pi.getSessionName`, and returns `{ success: true, name }` in details plus
a text confirmation. Validation/API/verification failures throw tool errors.
It never edits session files or starts another Pi process. Pi owns persistence.
The existing editor wrapper reads the current name on each render.

## Activation

Keep this directory linked at `~/.pi/agent/extensions/pi-session-name` (already
configured locally). In the **main Pi session**, run `/reload`: Pi reloads
extensions, skills, prompts, themes and context files. Subsequent model requests
can use `rename_session`. This does not itself rename the session.

If an older running session has not loaded the tool, use `/reload`, then ask again.
Manual fallback: `/name Workday 2026-09-15`. `/session` displays session information;
`/resume` lists the name. Never attempt to execute `/name` through a shell.
The user-global workday skill calls the tool only when workday mode is activated.

API references: installed Pi `docs/extensions.md` (custom tools, naming, reload),
`docs/skills.md`, `docs/sessions.md`, and `docs/session-format.md`.

## Tests

From the repository root, using the existing sibling checkout's Vitest:

```sh
../pi-mono/node_modules/.bin/vitest run --config extensions/pi-session-name/vitest.config.ts
```

The config resolves Pi and TypeBox from the installed Homebrew package. Set
`PI_CODING_AGENT_DIR` to the coding-agent package directory on other installations.
Tests mock ExtensionAPI registration/set/get; no real session is renamed.

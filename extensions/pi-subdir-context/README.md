# pi-subdir-context

A Pi extension that discovers nested, path-scoped instructions when Pi reads or mutates files. It expands the tool-result approach of the npm package with config-root precedence, Cursor rules, scoped skills, and mutation preflight protection.

## Install

Install the directory as a Pi package, or load it directly while developing:

```sh
pi -e ./src/index.ts
# or from its parent repository
pi install ./extensions/pi-subdir-context
```

The package manifest exposes `./src/index.ts` through `pi.extensions`; Pi runs the TypeScript source directly.

## Discovery

For a target such as `src/components/Button.tsx`, the extension visits every directory from the current project root through `src/components`, root first. At each directory it chooses **one** existing config root:

1. `.pi`
2. `.claude`
3. `.cursor`

Precedence is based on directory existence. If `.pi` exists in a directory, `.claude` and `.cursor` in that same directory are not inspected, even when `.pi` contains no applicable files. Selection is independent at each ancestor, so a root `.pi` and a nested `src/.cursor` can both contribute context. If the winning root is gitignored or resolves outside the project, that ancestor contributes nothing and does not fall back.

Within the selected root the extension loads:

- `AGENTS.override.md`, or `AGENTS.md` when no override exists
- `CLAUDE.md`
- for `.cursor` only, `rules/**/*.md` and `rules/**/*.mdc`
- `skills/*/SKILL.md`

Sources are deterministic and root-to-leaf, so deeper instructions appear later. Cursor rules and skills are sorted by path within their config root.

## Scoped skills

Nested `SKILL.md` files are context documents only. They are **not** registered as Pi skills and do not create slash commands.

A skill must have `name` and `description` frontmatter. `paths` is optional:

```md
---
name: frontend-tests
description: Testing rules for frontend source
paths:
  - src/**
  - "!src/generated/**"
---

Run component tests with ...
```

Patterns use gitignore matching relative to the directory containing the selected config root. Without `paths`, the skill applies to all target files beneath that directory. The injected context contains the complete `SKILL.md`, including frontmatter, plus source and scope labels.

## Tool behavior

- A successful built-in `read` result receives newly applicable context after its normal content.
- Before built-in `edit` or `write`, newly applicable context causes the call to be blocked. The block reason contains the context and tells the model to retry in a subsequent model turn. Pi preflights sibling tool calls before delivering results, so applicable sibling mutations are also blocked during the current turn; turn-scoped pending context is cleared only at the next `turn_start`. The later retry proceeds unless another safety-limit batch remains.
- Loaded files are deduplicated by canonical real path for the session. `session_start` clears loaded-source and discovery caches.
- Explicit reads or mutations of context files do not recursively load context. A complete successful explicit read counts that source as seen.

Only paths canonically inside `ctx.cwd` are considered. Symlink and `..` escapes are rejected, and `.git` and `node_modules` targets are skipped. Config-root selections, source scans, file contents, gitignore checks, and misses are cached; successful mutations invalidate discovery caches.

## Output limits

Injected context is limited to 50 KiB and 2,000 lines per operation, comparable to Pi's built-in tool defaults. Complete source documents are kept whenever they fit. If several sources exceed the aggregate limit, remaining sources are left unloaded for a later applicable operation. A single oversized source is truncated with an explicit notice so mutation preflight cannot loop forever.

## Development

```sh
npm test
npm run typecheck
```

# Pi Vitals

A customizable powerline-style footer for the pi coding agent. This extension provides a rich, informative status bar at the bottom of the terminal showing model info, git status, token usage, and more.

<img width="1014" height="45" alt="Screenshot 2026-02-15 at 4 44 54 PM" src="https://github.com/user-attachments/assets/278fb369-f3cf-47b9-9a6b-1e49c32ba3c9.png" />

## Features

- **Customizable segments**: Choose which info to display on the left and right sides
- **Smart git paths**: Shows `[repo_name]/relative/path` inside git repos, with correct handling for worktrees
- **Git integration**: Shows current branch and working tree status (staged, unstaged, untracked)
- **Extension status passthrough**: Displays status from other pi extensions (e.g., thinking-steps) that would otherwise be hidden when pi-vitals replaces the built-in footer
- **Token tracking**: Display input/output/total tokens and cache read/write
- **Context awareness**: Shows context window usage percentage
- **Thinking level**: Visual indicator of model reasoning level
- **Nerd Font support**: Automatic detection with ASCII fallbacks
- **Live updates**: Git status refreshes after every assistant message

## Installation

Install from npm using pi:

```bash
pi install npm:pi-vitals
```

Or copy the extension files to your pi extensions directory manually:

```bash
# Copy to global extensions directory
cp -r . ~/.pi/agent/extensions/pi-vitals

# Or use directly for testing
pi -e ./index.ts
```

## Configuration

Create `~/.pi/agent/powerline.json` to customize the footer:

```json
{
  "leftSegments": [
    "pi",
    "separator",
    "model",
    "thinking",
    "ext_status",
    "separator",
    "path",
    "git",
    "separator",
    "token_total",
    "token_in",
    "token_out",
    "cache_read",
    "cache_write"
  ],
  "rightSegments": [
    "separator",
    "context_pct"
  ],
  "icons": {
    "pi": "π",
    "model": "◈",
    "thinking": "🧠",
    "folder": "📁",
    "repo": "📦",
    "git": "⎇",
    "tokens": "⊛",
    "input": "↑",
    "output": "↓",
    "cacheRead": "↙",
    "cacheWrite": "↗",
    "contextPct": "◫",
    "separator": "|"
  },
  "colors": {
    "pi": "accent",
    "model": "#d787af",
    "path": "#00afaf",
    "git": "success",
    "gitDirty": "warning",
    "gitClean": "success",
    "thinking": "muted",
    "context": "dim",
    "contextWarn": "warning",
    "contextError": "error",
    "cost": "text",
    "tokens": "muted",
    "separator": "dim"
  },
  "segmentOptions": {
    "path": {
      "mode": "basename"
    },
    "git": {
      "showBranch": true,
      "showStaged": true,
      "showUnstaged": true,
      "showUntracked": true
    },
    "context_pct": {
      "showAutoIcon": false
    }
  }
}
```

## Available Segments

| Segment | Description |
|---------|-------------|
| `pi` | Pi logo/icon |
| `model` | Current model name |
| `thinking` | Thinking/reasoning level indicator |
| `ext_status` | Status text from other pi extensions (e.g., thinking-steps) |
| `path` | Current working directory |
| `git` | Git branch and status |
| `token_in` | Input tokens |
| `token_out` | Output tokens |
| `token_total` | Total tokens (input + output + cache) |
| `cache_read` | Cache read tokens |
| `cache_write` | Cache write tokens |
| `cost` | Estimated cost |
| `context_pct` | Context window usage percentage |
| `context_total` | Total context window size |
| `separator` | Visual separator icon |
| `text:...` | Custom text segment (e.g., `text:⚡`) |

## Smart Path Display

The `path` segment adapts based on whether you're inside a git repo:

- **Not in a git repo**: Shows the full current path
- **In a git repo**: Shows `[repo_name]/relative/path` with the repo icon
- **In a worktree**: Same format — uses the bare repo name, so `plexus/main` shows as `[plexus]` instead of redundantly showing `main main`

## Extension Status Passthrough

When pi-vitals replaces the built-in footer, status text from other extensions (set via `ctx.ui.setStatus()`) would normally be hidden. The `ext_status` segment reads these statuses from pi's footer data provider and displays them inline. For example, the [thinking-steps](https://github.com/mcowger/pi-thinking-steps) plugin's "thinking: summary" status appears automatically.

## Git Status Indicators

The `git` segment shows:
- Branch name with icon
- `*N` - Unstaged changes (warning color)
- `+N` - Staged changes (success color)
- `?N` - Untracked files (muted color)

Colors indicate clean (green) vs dirty (yellow) working tree.

Git status is refreshed after every assistant message and when file-changing tools are used.

## Commands

- `/footer reload` - Reload configuration from disk
- `/footer debug` - Show current configuration

## Path Modes

The `path` segment supports three modes:
- `basename` - Just the directory name, or `[repo_name]/relative/path` inside a git repo (default)
- `abbreviated` - Shortened path with `~` for home
- `full` - Full path

## Icons

The extension automatically detects Nerd Font support (via `TERM_PROGRAM` or `GHOSTTY_RESOURCES_DIR`) and uses appropriate icons. You can force Nerd Fonts with:

```bash
export POWERLINE_NERD_FONTS=1
```

Or disable with:

```bash
export POWERLINE_NERD_FONTS=0
```

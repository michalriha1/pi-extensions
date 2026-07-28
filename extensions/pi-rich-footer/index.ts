import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { createFooterRenderCache } from "./footer-render-cache.js";
import {
  disposeGitStatus,
  getGitStatus,
  invalidateGitStatus,
  invalidateGitBranch,
  invalidateGitRoot,
  setOnFetchComplete,
} from "./git-status.js";
import {
  createPresentationSnapshotController,
  type PresentationSnapshot,
} from "./presentation.js";
import { createSessionSnapshotController } from "./session-snapshot.js";

export default function powerlineFooter(pi: ExtensionAPI): void {
  const presentationSnapshots = createPresentationSnapshotController();
  let tuiRef: TUI | null = null;
  const renderTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const sessionSnapshots = createSessionSnapshotController(pi, () => tuiRef?.requestRender());

  const clearRenderTimers = (): void => {
    for (const timer of renderTimers.values()) clearTimeout(timer);
    renderTimers.clear();
  };
  const requestDelayedRender = (delayMs: number): void => {
    if (renderTimers.has(delayMs)) return;
    const timer = setTimeout(() => {
      renderTimers.delete(delayMs);
      tuiRef?.requestRender();
    }, delayMs);
    renderTimers.set(delayMs, timer);
  };

  pi.on("session_start", (_event, ctx) => {
    sessionSnapshots.start(ctx);
    if (ctx.hasUI) {
      const presentation = presentationSnapshots.getSnapshot();
      setupFooter(ctx, presentation);
      notifyConfigDiagnostics(ctx, presentation);
    }
  });

  pi.on("session_shutdown", () => {
    clearRenderTimers();
    tuiRef = null;
    sessionSnapshots.dispose();
    disposeGitStatus();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      sessionSnapshots.completeAssistant(event.message, ctx);
    }
    invalidateGitStatus();
  });

  pi.on("session_compact", (_event, ctx) => sessionSnapshots.rebuild(ctx));
  pi.on("session_tree", (_event, ctx) => sessionSnapshots.rebuild(ctx));
  pi.on("model_select", (event, ctx) => sessionSnapshots.selectModel(event.model, ctx));
  pi.on("thinking_level_select", (event, ctx) => {
    sessionSnapshots.selectThinkingLevel(event.level, ctx);
  });

  pi.on("agent_end", () => invalidateGitStatus());

  const invalidateForDirectoryChange = (): void => {
    invalidateGitRoot();
  };
  const isGitBranchCommand = (command: string): boolean => [
    /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
    /\bgit\s+stash\s+(pop|apply)/,
  ].some((pattern) => pattern.test(command));

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") invalidateGitStatus();
    const command = event.input.command;
    if (event.toolName !== "bash" || typeof command !== "string") return;
    if (/\b(cd|pushd|popd)\b/.test(command)) invalidateForDirectoryChange();
    if (isGitBranchCommand(command)) {
      invalidateForDirectoryChange();
      requestDelayedRender(100);
    }
  });

  pi.on("user_bash", (event) => {
    if (/\b(cd|pushd|popd)\b/.test(event.command)) {
      invalidateForDirectoryChange();
      requestDelayedRender(100);
      return;
    }
    if (isGitBranchCommand(event.command)) {
      invalidateForDirectoryChange();
      requestDelayedRender(100);
      requestDelayedRender(300);
      requestDelayedRender(500);
    }
  });

  pi.registerCommand("footer", {
    description: "Configure footer extension (reload, debug)",
    handler: async (args, ctx) => {
      if (!args || args.trim().toLowerCase() === "reload") {
        const presentation = presentationSnapshots.reload();
        if (ctx.hasUI) setupFooter(ctx, presentation);
        if (!notifyConfigDiagnostics(ctx, presentation)) {
          if (presentation.hasUserConfig) {
            ctx.ui.notify("Footer config reloaded", "info");
          } else {
            ctx.ui.notify("No config file found at ~/.pi/agent/powerline.json", "warning");
          }
        }
        return;
      }

      if (args.trim().toLowerCase() === "debug") {
        const presentation = presentationSnapshots.getSnapshot();
        const lines = [
          `Left: ${presentation.leftSegments.join(", ")}`,
          `Right: ${presentation.rightSegments.join(", ")}`,
          `Custom icons: ${presentation.customIconNames.join(", ") || "none"}`,
        ];
        ctx.ui.notify(lines.join(" | "), "info");
        return;
      }

      ctx.ui.notify("Usage: /footer [reload|debug]", "info");
    },
  });

  function notifyConfigDiagnostics(ctx: ExtensionContext, presentation: PresentationSnapshot): boolean {
    if (presentation.configDiagnostics.length === 0) return false;
    ctx.ui.notify(
      `Footer config has invalid values; valid settings were kept and defaults used for invalid settings: ${presentation.configDiagnostics.join("; ")}`,
      "warning",
    );
    return true;
  }

  function setupFooter(ctx: ExtensionContext, presentation: PresentationSnapshot): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;
      const renderCache = createFooterRenderCache();
      setOnFetchComplete(() => tui.requestRender());
      const unsubscribeBranch = footerData.onBranchChange(() => {
        invalidateGitBranch();
        tui.requestRender();
      });

      return {
        dispose: () => {
          unsubscribeBranch();
          clearRenderTimers();
          setOnFetchComplete(null);
          renderCache.dispose();
          disposeGitStatus();
          if (tuiRef === tui) tuiRef = null;
        },
        invalidate() {
          renderCache.invalidateTheme();
        },
        render(width: number): string[] {
          const snapshot = sessionSnapshots.getSnapshot();
          if (!snapshot) return [];
          return renderCache.render({
            width,
            cwd: process.cwd(),
            theme,
            presentation,
            session: snapshot,
            git: getGitStatus(footerData.getGitBranch()),
            extensionStatuses: footerData.getExtensionStatuses(),
          });
        },
      };
    });
  }
}

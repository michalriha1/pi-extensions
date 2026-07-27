import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SubdirContextManager } from "./context-manager.ts";
import type { LoadedContext } from "./types.ts";

export default function piSubdirContext(pi: ExtensionAPI): void {
  let managerPromise: Promise<SubdirContextManager> | undefined;
  let managerCwd = "";
  const mutationContextsBlockedThisTurn = new Map<string, LoadedContext>();

  const managerFor = (ctx: ExtensionContext): Promise<SubdirContextManager> => {
    if (!managerPromise || managerCwd !== ctx.cwd) {
      managerCwd = ctx.cwd;
      managerPromise = SubdirContextManager.create(ctx.cwd);
    }
    return managerPromise;
  };

  pi.on("session_start", async (_event, ctx) => {
    mutationContextsBlockedThisTurn.clear();
    managerCwd = ctx.cwd;
    managerPromise = SubdirContextManager.create(ctx.cwd);
    await managerPromise;
  });

  pi.on("turn_start", () => {
    // Block reasons from the preceding turn have now entered model context.
    // Until this boundary, every sibling mutation sharing those instructions
    // must still be blocked even though the manager has deduplicated the files.
    mutationContextsBlockedThisTurn.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (!isProjectTrusted(ctx)) return undefined;

    try {
      const manager = await managerFor(ctx);
      const target = await manager.resolveTarget(extractPath(event.input));
      if (!target || manager.discovery.isPotentialContextFile(target)) return undefined;

      const pendingContexts = await pendingContextsForTarget(
        manager,
        target,
        mutationContextsBlockedThisTurn,
      );
      const batch = await manager.contextForTarget(target);
      for (const context of batch.contexts) {
        mutationContextsBlockedThisTurn.set(context.source.realPath, context);
      }

      if (batch.contexts.length === 0 && pendingContexts.length === 0) return undefined;

      // Prefer newly loaded context when output batching exposes another chunk;
      // otherwise replay the applicable context that blocked an earlier sibling.
      const contextText = batch.contexts.length > 0
        ? batch.text
        : pendingContexts.map((context) => context.text).join("\n\n");
      const continuation = batch.truncated
        ? "\n\nAdditional context remains because the safety limit was reached; retrying may be preflight-blocked again."
        : "";
      return {
        block: true,
        reason:
          `Blocked ${event.toolName} before mutation. Newly applicable path-scoped context must be read first. ` +
          `Review the context below, then retry the same ${event.toolName} call in a subsequent model turn.${continuation}\n\n${contextText}`,
      };
    } catch (error) {
      notifyFailure(ctx, error);
      return undefined;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isProjectTrusted(ctx)) return undefined;

    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      try {
        const manager = await managerFor(ctx);
        const target = await manager.resolveTarget(extractPath(event.input));
        if (target) await manager.noteSuccessfulMutation(target);
      } catch (error) {
        notifyFailure(ctx, error);
      }
      return undefined;
    }

    if (event.toolName !== "read" || event.isError) return undefined;

    try {
      const manager = await managerFor(ctx);
      const target = await manager.resolveTarget(extractPath(event.input));
      if (!target) return undefined;

      if (manager.discovery.isPotentialContextFile(target)) {
        await manager.noteSuccessfulContextRead(target, isPartialRead(event.input));
        return undefined;
      }

      const batch = await manager.contextForTarget(target);
      if (batch.contexts.length === 0) return undefined;

      const safetyNotice = batch.truncated
        ? "\n\n[pi-subdir-context: output safety limit reached; remaining context will load on a later applicable file operation.]"
        : "";
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Path-scoped context loaded for this successful read:\n\n${batch.text}${safetyNotice}`,
          },
        ],
        details: event.details,
      };
    } catch (error) {
      notifyFailure(ctx, error);
      return undefined;
    }
  });
}

async function pendingContextsForTarget(
  manager: SubdirContextManager,
  target: string,
  pending: ReadonlyMap<string, LoadedContext>,
): Promise<LoadedContext[]> {
  if (pending.size === 0) return [];
  const applicableSources = await manager.discovery.discover(target);
  return applicableSources.flatMap((source) => {
    const context = pending.get(source.realPath);
    return context ? [context] : [];
  });
}

export function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.path === "string") return record.path;
  // Harmless compatibility with wrappers that retain the built-in path under args.
  if (record.args && typeof record.args === "object") {
    const nestedPath = (record.args as Record<string, unknown>).path;
    if (typeof nestedPath === "string") return nestedPath;
  }
  return undefined;
}

function isPartialRead(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return record.offset !== undefined || record.limit !== undefined;
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
  if (ctx.hasUI) ctx.ui.notify(`pi-subdir-context skipped context: ${String(error)}`, "warning");
}

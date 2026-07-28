import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PresentationSnapshot } from "./presentation.js";
import { renderSegment } from "./segments.js";
import type { SessionSnapshot } from "./session-snapshot.js";
import type { GitStatus, SegmentContext, StatusLineSegmentId } from "./types.js";

export interface FooterRenderInstrumentation {
  segmentRenders: number;
  layoutPasses: number;
  widthPasses: number;
  truncationPasses: number;
  statusSorts: number;
  finalRowAllocations: number;
}

export interface FooterRenderInput {
  width: number;
  cwd: string;
  theme: Theme;
  presentation: PresentationSnapshot;
  session: SessionSnapshot;
  git: GitStatus;
  extensionStatuses: ReadonlyMap<string, string>;
}

export interface FooterRenderCache {
  render(input: FooterRenderInput): string[];
  invalidateTheme(): void;
  clear(): void;
  dispose(): void;
}

interface ExtensionStatusSnapshot {
  readonly values: ReadonlyMap<string, string>;
  readonly text: string;
}

interface CacheEntry {
  readonly cwd: string;
  readonly theme: Theme;
  readonly themeGeneration: number;
  readonly presentation: PresentationSnapshot;
  readonly session: SessionSnapshot;
  readonly git: GitStatus;
  readonly statuses: ExtensionStatusSnapshot;
  readonly rows: string[];
}

function statusMapsEqual(
  statuses: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string>,
): boolean {
  if (statuses.size !== previous.size) return false;
  for (const [key, value] of statuses) {
    if (previous.get(key) !== value || !previous.has(key)) return false;
  }
  return true;
}

function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext,
  instrumentation?: FooterRenderInstrumentation,
): { content: string; width: number; visible: boolean } {
  if (instrumentation) instrumentation.segmentRenders++;
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  if (instrumentation) instrumentation.widthPasses++;
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

function truncate(
  text: string,
  width: number,
  instrumentation?: FooterRenderInstrumentation,
): string {
  if (instrumentation) instrumentation.truncationPasses++;
  return truncateToWidth(text, width);
}

export function buildFooterContent(
  ctx: SegmentContext,
  leftSegments: readonly StatusLineSegmentId[],
  rightSegments: readonly StatusLineSegmentId[],
  availableWidth: number,
  instrumentation?: FooterRenderInstrumentation,
): string {
  if (instrumentation) instrumentation.layoutPasses++;
  const rowWidth = Math.max(0, Math.floor(availableWidth));
  if (rowWidth <= 1) return " ".repeat(rowWidth);
  const maxContentWidth = rowWidth - 2;
  const fitRow = (text: string): string => {
    const fitted = truncate(text, rowWidth, instrumentation);
    if (instrumentation) instrumentation.widthPasses++;
    return `${fitted}${" ".repeat(Math.max(0, rowWidth - visibleWidth(fitted)))}`;
  };
  const leftParts: string[] = [];
  let leftWidth = 0;
  for (const segId of leftSegments) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx, instrumentation);
    if (visible) {
      leftParts.push(content);
      leftWidth += width + 1;
    }
  }
  if (leftParts.length > 0) leftWidth--;

  const rightParts: string[] = [];
  let rightWidth = 0;
  for (const segId of rightSegments) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx, instrumentation);
    if (visible) {
      rightParts.push(content);
      rightWidth += width + 1;
    }
  }
  if (rightParts.length > 0) rightWidth--;

  const leftStr = leftParts.join(" ");
  const rightStr = rightParts.join(" ");
  if (rightParts.length === 0) {
    const finalLeft = truncate(leftStr, maxContentWidth, instrumentation);
    if (instrumentation) instrumentation.widthPasses++;
    return fitRow(` ${finalLeft}${" ".repeat(Math.max(0, maxContentWidth - visibleWidth(finalLeft)))} `);
  }
  if (rightWidth >= maxContentWidth) {
    return fitRow(` ${truncate(rightStr, maxContentWidth, instrumentation)} `);
  }

  const maxLeftWidth = maxContentWidth - rightWidth - 1;
  const finalLeft = truncate(leftStr, Math.max(0, maxLeftWidth), instrumentation);
  if (instrumentation) instrumentation.widthPasses++;
  const padding = maxContentWidth - visibleWidth(finalLeft) - rightWidth;
  return fitRow(` ${finalLeft}${" ".repeat(padding)}${rightStr} `);
}

export function createFooterRenderCache(
  instrumentation?: FooterRenderInstrumentation,
): FooterRenderCache {
  const entries = new Map<number, CacheEntry>();
  let themeGeneration = 0;
  let statusSnapshot: ExtensionStatusSnapshot | null = null;
  let disposed = false;

  const getStatusSnapshot = (
    statuses: ReadonlyMap<string, string>,
  ): ExtensionStatusSnapshot => {
    if (statusSnapshot && statusMapsEqual(statuses, statusSnapshot.values)) return statusSnapshot;
    if (instrumentation) instrumentation.statusSorts++;
    const sorted = Array.from(statuses.entries()).sort(([a], [b]) => a.localeCompare(b));
    statusSnapshot = {
      values: new Map(sorted),
      text: sorted.map(([, text]) => text).join(" "),
    };
    return statusSnapshot;
  };

  return {
    render(input) {
      if (disposed) return [];
      const statuses = getStatusSnapshot(input.extensionStatuses);
      const cached = entries.get(input.width);
      if (cached
        && cached.cwd === input.cwd
        && cached.theme === input.theme
        && cached.themeGeneration === themeGeneration
        && cached.presentation === input.presentation
        && cached.session === input.session
        && cached.git === input.git
        && cached.statuses === statuses) {
        return cached.rows;
      }

      const ctx: SegmentContext = {
        model: input.session.model,
        thinkingLevel: input.session.thinkingLevel,
        sessionId: input.session.sessionId,
        usageStats: input.session.usageStats,
        contextPercent: input.session.contextPercent,
        contextWindow: input.session.contextWindow,
        autoCompactEnabled: input.session.autoCompactEnabled,
        usingSubscription: input.session.usingSubscription,
        sessionStartTime: input.session.sessionStartTime,
        cwd: input.cwd,
        git: input.git,
        extensionStatusText: statuses.text,
        options: input.presentation.segmentOptions,
        width: input.width,
        theme: input.theme,
        colors: input.presentation.colors,
        icons: input.presentation.icons,
        thinkingLabels: input.presentation.thinkingLabels,
      };
      if (instrumentation) instrumentation.finalRowAllocations++;
      const rows = [buildFooterContent(
        ctx,
        input.presentation.leftSegments,
        input.presentation.rightSegments,
        input.width,
        instrumentation,
      )];
      entries.set(input.width, {
        cwd: input.cwd,
        theme: input.theme,
        themeGeneration,
        presentation: input.presentation,
        session: input.session,
        git: input.git,
        statuses,
        rows,
      });
      return rows;
    },
    invalidateTheme() {
      if (disposed) return;
      themeGeneration++;
      entries.clear();
    },
    clear() {
      entries.clear();
      statusSnapshot = null;
    },
    dispose() {
      disposed = true;
      entries.clear();
      statusSnapshot = null;
    },
  };
}

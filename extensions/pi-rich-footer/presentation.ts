import { clearUserConfigCache, getConfigState, type ConfigState } from "./config.js";
import { hasNerdFonts, mergeIcons, type IconSet } from "./icons.js";
import type { ColorScheme, StatusLineSegmentId, StatusLineSegmentOptions, ThinkingLabels } from "./types.js";

const ASCII_THINKING_LABELS: ThinkingLabels = Object.freeze({
  minimal: "[min]",
  low: "[low]",
  medium: "[med]",
  high: "[high]",
  xhigh: "[xhi]",
});

const NERD_THINKING_LABELS: ThinkingLabels = Object.freeze({
  minimal: "\u{F0E7} min",
  low: "\u{F10C} low",
  medium: "\u{F192} med",
  high: "\u{F111} high",
  xhigh: "\u{F06D} xhi",
});

export interface PresentationSnapshot {
  readonly leftSegments: readonly StatusLineSegmentId[];
  readonly rightSegments: readonly StatusLineSegmentId[];
  readonly colors: ColorScheme;
  readonly segmentOptions: StatusLineSegmentOptions;
  readonly icons: IconSet;
  readonly nerdFonts: boolean;
  readonly thinkingLabels: ThinkingLabels;
  readonly customIconNames: readonly string[];
  readonly hasUserConfig: boolean;
  readonly configFound: boolean;
  readonly configDiagnostics: readonly string[];
}

export interface PresentationSnapshotDependencies {
  getConfigState(): ConfigState;
  clearConfig(): void;
  detectNerdFonts(): boolean;
  mergeIcons(nerdFonts: boolean, customIcons: Partial<IconSet>): IconSet;
}

export interface PresentationSnapshotController {
  getSnapshot(): PresentationSnapshot;
  reload(): PresentationSnapshot;
}

const DEFAULT_DEPENDENCIES: PresentationSnapshotDependencies = {
  getConfigState,
  clearConfig: clearUserConfigCache,
  detectNerdFonts: hasNerdFonts,
  mergeIcons,
};

export function createPresentationSnapshot(
  dependencies: PresentationSnapshotDependencies = DEFAULT_DEPENDENCIES,
): PresentationSnapshot {
  const configState = dependencies.getConfigState();
  const nerdFonts = dependencies.detectNerdFonts();
  const effectiveConfig = configState.effectiveConfig;

  return Object.freeze({
    leftSegments: effectiveConfig.leftSegments,
    rightSegments: effectiveConfig.rightSegments,
    colors: effectiveConfig.colors,
    segmentOptions: effectiveConfig.segmentOptions,
    icons: Object.freeze(dependencies.mergeIcons(nerdFonts, effectiveConfig.icons)),
    nerdFonts,
    thinkingLabels: nerdFonts ? NERD_THINKING_LABELS : ASCII_THINKING_LABELS,
    customIconNames: Object.freeze(Object.keys(effectiveConfig.icons)),
    hasUserConfig: Boolean(configState.userConfig),
    configFound: configState.configFound,
    configDiagnostics: configState.diagnostics,
  });
}

export function createPresentationSnapshotController(
  dependencies: PresentationSnapshotDependencies = DEFAULT_DEPENDENCIES,
): PresentationSnapshotController {
  let snapshot: PresentationSnapshot | undefined;

  return {
    getSnapshot() {
      snapshot ??= createPresentationSnapshot(dependencies);
      return snapshot;
    },
    reload() {
      dependencies.clearConfig();
      snapshot = createPresentationSnapshot(dependencies);
      return snapshot;
    },
  };
}

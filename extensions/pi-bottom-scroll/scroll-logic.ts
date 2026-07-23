export type ScrollDirection = -1 | 1;

export interface ScrollAcceleration {
	lastDirection: ScrollDirection | 0;
	lastEventAt: number;
	rapidEventCount: number;
}

export interface ScrollState {
	viewportTop: number;
	followBottom: boolean;
	pendingDelta: number;
	acceleration: ScrollAcceleration;
}

export interface ScrollBounds {
	historyLineCount: number;
	viewportRows: number;
}

export interface ScrollFrameResult {
	state: ScrollState;
	appliedDelta: number;
	changed: boolean;
}

const SAME_BATCH_WINDOW_MS = 5;
const RAPID_EVENT_WINDOW_MS = 45;
const ACCELERATION_START_EVENT_COUNT = 9;
const ACCELERATION_EVENTS_PER_STEP = 3;
const ACCELERATION_CAP = 6;
const SMALL_PENDING_THRESHOLD = 4;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(value, maximum));
}

function maximumViewportTop(bounds: ScrollBounds): number {
	return Math.max(0, Math.trunc(bounds.historyLineCount) - Math.max(0, Math.trunc(bounds.viewportRows)));
}

export function createScrollState(): ScrollState {
	return {
		viewportTop: 0,
		followBottom: true,
		pendingDelta: 0,
		acceleration: {
			lastDirection: 0,
			lastEventAt: Number.NEGATIVE_INFINITY,
			rapidEventCount: 0,
		},
	};
}

export function addWheelInput(state: ScrollState, direction: ScrollDirection, now: number): ScrollState {
	const gap = now - state.acceleration.lastEventAt;
	const sameDirection = state.acceleration.lastDirection === direction;
	if (sameDirection && gap >= 0 && gap < SAME_BATCH_WINDOW_MS) return state;

	const rapidEventCount = sameDirection && gap >= 0 && gap <= RAPID_EVENT_WINDOW_MS
		? state.acceleration.rapidEventCount + 1
		: 0;
	const step = rapidEventCount < ACCELERATION_START_EVENT_COUNT
		? 1
		: Math.min(
			ACCELERATION_CAP,
			2 + Math.floor((rapidEventCount - ACCELERATION_START_EVENT_COUNT) / ACCELERATION_EVENTS_PER_STEP),
		);
	const reversing = state.acceleration.lastDirection !== 0 && !sameDirection;

	return {
		...state,
		pendingDelta: reversing ? direction * step : state.pendingDelta + direction * step,
		acceleration: {
			lastDirection: direction,
			lastEventAt: now,
			rapidEventCount,
		},
	};
}

export function reconcileScrollBounds(state: ScrollState, bounds: ScrollBounds): ScrollState {
	const maximum = maximumViewportTop(bounds);
	return {
		...state,
		viewportTop: state.followBottom ? maximum : clamp(Math.trunc(state.viewportTop), 0, maximum),
	};
}

export function drainScrollFrame(state: ScrollState, bounds: ScrollBounds): ScrollFrameResult {
	const reconciled = reconcileScrollBounds(state, bounds);
	const pending = Math.trunc(reconciled.pendingDelta);
	if (pending === 0) {
		return { state: { ...reconciled, pendingDelta: 0 }, appliedDelta: 0, changed: false };
	}

	const pendingMagnitude = Math.abs(pending);
	const viewportCap = Math.max(1, Math.trunc(bounds.viewportRows) - 1);
	const drainMagnitude = pendingMagnitude <= SMALL_PENDING_THRESHOLD
		? pendingMagnitude
		: Math.min(viewportCap, Math.max(2, Math.ceil(pendingMagnitude / 2)));
	const requestedDelta = pending > 0 ? drainMagnitude : -drainMagnitude;
	const maximum = maximumViewportTop(bounds);
	const nextTop = clamp(reconciled.viewportTop + requestedDelta, 0, maximum);
	const appliedDelta = nextTop - reconciled.viewportTop;
	const hitBoundary = appliedDelta !== requestedDelta;
	const pendingDelta = hitBoundary ? 0 : pending - requestedDelta;
	const followBottom = nextTop >= maximum;

	return {
		state: {
			...reconciled,
			viewportTop: nextTop,
			followBottom,
			pendingDelta,
		},
		appliedDelta,
		changed: appliedDelta !== 0 || reconciled.followBottom !== followBottom,
	};
}

export function resetScrollMotion(state: ScrollState): ScrollState {
	return {
		...state,
		pendingDelta: 0,
		acceleration: {
			lastDirection: 0,
			lastEventAt: Number.NEGATIVE_INFINITY,
			rapidEventCount: 0,
		},
	};
}

import assert from "node:assert/strict";
import test from "node:test";

import {
	addWheelInput,
	createScrollState,
	drainScrollFrame,
	reconcileScrollBounds,
} from "../scroll-logic.ts";

const BOUNDS = { historyLineCount: 100, viewportRows: 20 };

test("slow wheel input is exactly one row and resets acceleration after a gap", () => {
	let state = reconcileScrollBounds(createScrollState(), BOUNDS);
	state = addWheelInput(state, -1, 1_000);
	assert.equal(state.pendingDelta, -1);
	state = drainScrollFrame(state, BOUNDS).state;
	assert.equal(state.viewportTop, 79);

	state = addWheelInput(state, -1, 1_200);
	assert.equal(state.pendingDelta, -1);
});

test("same-batch reports collapse to one row without advancing acceleration", () => {
	let state = { ...createScrollState(), viewportTop: 50, followBottom: false };
	state = addWheelInput(state, 1, 0);
	state = addWheelInput(state, 1, 1);
	state = addWheelInput(state, 1, 2);
	assert.equal(state.pendingDelta, 1);
	assert.deepEqual(state.acceleration, {
		lastDirection: 1,
		lastEventAt: 0,
		rapidEventCount: 0,
	});

	const frame = drainScrollFrame(state, BOUNDS);
	assert.equal(frame.appliedDelta, 1);
	assert.equal(frame.state.viewportTop, 51);
	assert.equal(frame.state.pendingDelta, 0);
});

test("same-direction input at the same-batch boundary is accepted", () => {
	let state = createScrollState();
	state = addWheelInput(state, 1, 0);
	state = addWheelInput(state, 1, 5);
	assert.equal(state.pendingDelta, 2);
	assert.equal(state.acceleration.lastEventAt, 5);
	assert.equal(state.acceleration.rapidEventCount, 1);
});

test("sustained accepted input starts acceleration on the tenth event and ramps gently to the cap", () => {
	let state = createScrollState();
	const steps: number[] = [];
	for (let index = 0; index < 24; index += 1) {
		const before = state.pendingDelta;
		state = addWheelInput(state, 1, index * 10);
		steps.push(state.pendingDelta - before);
	}
	assert.deepEqual(steps.slice(0, 13), [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3]);
	assert.equal(Math.max(...steps), 6);
	assert.equal(steps.at(-1), 6);
});

test("bursts accumulate before a render", () => {
	let state = createScrollState();
	state = addWheelInput(state, -1, 0);
	state = addWheelInput(state, -1, 10);
	state = addWheelInput(state, -1, 20);
	state = addWheelInput(state, -1, 30);
	assert.equal(state.pendingDelta, -4);
});

test("large pending deltas drain adaptively across multiple frames", () => {
	let state = { ...createScrollState(), viewportTop: 50, followBottom: false, pendingDelta: 20 };
	const applied: number[] = [];
	while (state.pendingDelta !== 0) {
		const frame = drainScrollFrame(state, BOUNDS);
		applied.push(frame.appliedDelta);
		state = frame.state;
	}
	assert.deepEqual(applied, [10, 5, 3, 2]);
	assert.equal(state.viewportTop, 70);
});

test("direction reversal discards old momentum and applies promptly", () => {
	let state = { ...createScrollState(), viewportTop: 40, followBottom: false };
	for (let index = 0; index < 8; index += 1) state = addWheelInput(state, 1, index * 10);
	assert.equal(state.pendingDelta, 8);
	state = addWheelInput(state, -1, 71);
	assert.equal(state.pendingDelta, -1);
	assert.equal(state.acceleration.lastEventAt, 71);
	const frame = drainScrollFrame(state, BOUNDS);
	assert.equal(frame.appliedDelta, -1);
	assert.equal(frame.state.viewportTop, 39);
});

test("bounds clamp pending motion and follow-bottom tracks growth", () => {
	let state = reconcileScrollBounds(createScrollState(), BOUNDS);
	assert.equal(state.viewportTop, 80);
	state = reconcileScrollBounds(state, { historyLineCount: 110, viewportRows: 20 });
	assert.equal(state.viewportTop, 90);

	state = addWheelInput(state, -1, 1_000);
	state = drainScrollFrame(state, { historyLineCount: 110, viewportRows: 20 }).state;
	assert.equal(state.followBottom, false);
	state = reconcileScrollBounds(state, { historyLineCount: 120, viewportRows: 20 });
	assert.equal(state.viewportTop, 89);

	state = { ...state, viewportTop: 0, pendingDelta: -20 };
	const topFrame = drainScrollFrame(state, { historyLineCount: 120, viewportRows: 20 });
	assert.equal(topFrame.state.viewportTop, 0);
	assert.equal(topFrame.state.pendingDelta, 0);
});

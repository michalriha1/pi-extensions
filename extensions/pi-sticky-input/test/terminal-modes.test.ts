import assert from "node:assert/strict";
import test from "node:test";

import { decodeAlternateScrollCursorSequence } from "../index.ts";
import {
	DISABLE_DEC_ALTERNATE_SCROLL,
	ENABLE_DEC_ALTERNATE_SCROLL,
	ENTER_ALTERNATE_SCREEN,
	EXIT_ALTERNATE_SCREEN,
	POP_KITTY_KEYBOARD_PROTOCOL,
	PUSH_KITTY_KEYBOARD_PROTOCOL,
	TerminalModes,
} from "../terminal-modes.ts";

class RecordingTerminal {
	readonly writes: string[] = [];

	write(data: string): void {
		this.writes.push(data);
	}
}

test("terminal modes activate and deactivate in protocol order", () => {
	const terminal = new RecordingTerminal();
	const modes = new TerminalModes(terminal);
	modes.activate();
	modes.deactivate();
	assert.deepEqual(terminal.writes, [
		ENTER_ALTERNATE_SCREEN + PUSH_KITTY_KEYBOARD_PROTOCOL + ENABLE_DEC_ALTERNATE_SCROLL,
		DISABLE_DEC_ALTERNATE_SCROLL + POP_KITTY_KEYBOARD_PROTOCOL + EXIT_ALTERNATE_SCREEN,
	]);
});

test("terminal mode transitions are idempotent and never enable SGR mouse reporting", () => {
	const terminal = new RecordingTerminal();
	const modes = new TerminalModes(terminal);
	modes.activate();
	modes.activate();
	modes.deactivate();
	modes.deactivate();
	assert.equal(terminal.writes.length, 2);
	const output = terminal.writes.join("");
	for (const forbiddenMode of ["1000", "1002", "1003", "1006"]) {
		assert.equal(output.includes(forbiddenMode), false);
	}
});

test("DEC alternate-scroll cursor reports are decoded in isolation", () => {
	assert.equal(decodeAlternateScrollCursorSequence("\x1b[A"), "up");
	assert.equal(decodeAlternateScrollCursorSequence("\x1bOA"), "up");
	assert.equal(decodeAlternateScrollCursorSequence("\x1b[B"), "down");
	assert.equal(decodeAlternateScrollCursorSequence("\x1bOB"), "down");
	assert.equal(decodeAlternateScrollCursorSequence("x"), undefined);
	assert.equal(decodeAlternateScrollCursorSequence("\x1b[<64;1;1M"), undefined);
});

test("enhanced Kitty physical Up/Down sequences are not decoded as wheel input", () => {
	for (const sequence of ["\x1b[1;1A", "\x1b[1;1B", "\x1b[1;1:2A", "\x1b[1;1:3B"]) {
		assert.equal(decodeAlternateScrollCursorSequence(sequence), undefined);
	}
});

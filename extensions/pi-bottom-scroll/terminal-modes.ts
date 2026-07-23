export interface TerminalModeWriter {
	write(data: string): void;
}

export const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
export const PUSH_KITTY_KEYBOARD_PROTOCOL = "\x1b[>7u";
export const ENABLE_DEC_ALTERNATE_SCROLL = "\x1b[?1007h";
export const DISABLE_DEC_ALTERNATE_SCROLL = "\x1b[?1007l";
export const POP_KITTY_KEYBOARD_PROTOCOL = "\x1b[<u";
export const EXIT_ALTERNATE_SCREEN = "\x1b[?1049l";

export class TerminalModes {
	private readonly terminal: TerminalModeWriter;
	private active = false;

	constructor(terminal: TerminalModeWriter) {
		this.terminal = terminal;
	}

	activate(): void {
		if (this.active) return;
		this.active = true;
		this.terminal.write(ENTER_ALTERNATE_SCREEN + PUSH_KITTY_KEYBOARD_PROTOCOL + ENABLE_DEC_ALTERNATE_SCROLL);
	}

	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		this.terminal.write(DISABLE_DEC_ALTERNATE_SCROLL + POP_KITTY_KEYBOARD_PROTOCOL + EXIT_ALTERNATE_SCREEN);
	}

	isActive(): boolean {
		return this.active;
	}
}

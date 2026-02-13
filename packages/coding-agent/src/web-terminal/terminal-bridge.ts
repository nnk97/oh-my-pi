import type { TUI } from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui";

export type WebTerminalOutputListener = (data: string) => void;

export interface WebTerminalBridge {
	onOutput(listener: WebTerminalOutputListener): () => void;
	injectInput(data: string): void;
	setSize(cols: number, rows: number): void;
	clearSize(): void;
	requestFullRender(): void;
	getSize(): { cols: number; rows: number };
}

export class MirroredTerminal extends ProcessTerminal {
	#outputListeners = new Set<WebTerminalOutputListener>();
	#inputHandler?: (data: string) => void;
	#overrideSize: { cols: number; rows: number } | null = null;

	onOutput(listener: WebTerminalOutputListener): () => void {
		this.#outputListeners.add(listener);
		return () => {
			this.#outputListeners.delete(listener);
		};
	}

	injectInput(data: string): void {
		this.#inputHandler?.(data);
	}

	setSize(cols: number, rows: number): void {
		this.#overrideSize = { cols, rows };
	}

	clearSize(): void {
		this.#overrideSize = null;
	}

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		super.write(data);
		for (const listener of this.#outputListeners) {
			listener(data);
		}
	}

	override get columns(): number {
		return this.#overrideSize?.cols ?? super.columns;
	}

	override get rows(): number {
		return this.#overrideSize?.rows ?? super.rows;
	}
}

let activeBridge: WebTerminalBridge | null = null;

export function createWebTerminalBridge(ui: TUI, terminal: MirroredTerminal): WebTerminalBridge {
	return {
		onOutput: listener => terminal.onOutput(listener),
		injectInput: data => terminal.injectInput(data),
		setSize: (cols, rows) => terminal.setSize(cols, rows),
		clearSize: () => terminal.clearSize(),
		requestFullRender: () => ui.requestFullRender(),
		getSize: () => ({ cols: terminal.columns, rows: terminal.rows }),
	};
}

export function setActiveWebTerminalBridge(bridge: WebTerminalBridge | null): void {
	activeBridge = bridge;
}

export function getActiveWebTerminalBridge(): WebTerminalBridge | null {
	return activeBridge;
}

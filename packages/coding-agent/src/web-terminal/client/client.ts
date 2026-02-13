import { Terminal } from "@xterm/xterm";

const terminalRoot = (() => {
	const element = document.getElementById("terminal");
	if (!(element instanceof HTMLElement)) {
		throw new Error("Terminal container not found");
	}
	return element;
})();

const FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", "Consolas", "DejaVu Sans Mono", monospace';
const FONT_SIZE = 14;

let term: Terminal | null = null;
let ws: WebSocket | null = null;
let resizeTimer: number | null = null;
let lastContainerWidth = 0;
let lastContainerHeight = 0;
let lastSentCols = 0;
let lastSentRows = 0;

function collectSizing(): Record<string, unknown> {
	const xterm = terminalRoot.querySelector(".xterm");
	const viewport = terminalRoot.querySelector(".xterm-viewport");
	const screen = terminalRoot.querySelector(".xterm-screen");
	return {
		terminal: { w: terminalRoot.clientWidth, h: terminalRoot.clientHeight },
		xterm: xterm ? { w: xterm.clientWidth, h: xterm.clientHeight } : null,
		viewport: viewport ? { w: viewport.clientWidth, h: viewport.clientHeight } : null,
		screen: screen ? { w: (screen as HTMLElement).clientWidth, h: (screen as HTMLElement).clientHeight } : null,
	};
}

function sendMessage(payload: object): void {
	if (ws?.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify(payload));
}

function measureCell(): { width: number; height: number } {
	const probe = document.createElement("span");
	probe.textContent = "MMMMMMMMMM";
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	probe.style.whiteSpace = "pre";
	probe.style.fontFamily = FONT_FAMILY;
	probe.style.fontSize = `${FONT_SIZE}px`;
	probe.style.lineHeight = "1";
	terminalRoot.appendChild(probe);
	const rect = probe.getBoundingClientRect();
	probe.remove();

	const charWidth = rect.width > 0 ? rect.width / 10 : 8;
	const lineHeight = rect.height > 0 ? rect.height * 1.2 : 17;
	return {
		width: Math.max(1, charWidth),
		height: Math.max(1, lineHeight),
	};
}

function computeDimensions(): { cols: number; rows: number } | null {
	if (!term) return null;
	const rect = terminalRoot.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;

	const cell = measureCell();
	const cols = Math.max(2, Math.floor(rect.width / cell.width));
	const rows = Math.max(1, Math.floor(rect.height / cell.height));
	if (term.cols !== cols || term.rows !== rows) {
		term.resize(cols, rows);
	}
	return { cols, rows };
}

function sendResize(): void {
	const dimensions = computeDimensions();
	if (!dimensions) {
		console.log("[web-terminal] resize skipped", collectSizing());
		return;
	}
	if (dimensions.cols === lastSentCols && dimensions.rows === lastSentRows) {
		return;
	}
	lastSentCols = dimensions.cols;
	lastSentRows = dimensions.rows;
	const payload = { type: "resize", cols: dimensions.cols, rows: dimensions.rows };
	console.log("[web-terminal] resize", payload, collectSizing());
	sendMessage(payload);
}

function scheduleResize(reason: string): void {
	if (resizeTimer !== null) {
		window.clearTimeout(resizeTimer);
	}
	console.log("[web-terminal] scheduleResize", { reason });
	resizeTimer = window.setTimeout(() => {
		resizeTimer = null;
		sendResize();
	}, 80);
}

function attachResizeHooks(): void {
	const resizeObserver = new ResizeObserver(entries => {
		const entry = entries[0];
		if (!entry) return;
		const width = Math.round(entry.contentRect.width);
		const height = Math.round(entry.contentRect.height);
		if (width === lastContainerWidth && height === lastContainerHeight) {
			return;
		}
		lastContainerWidth = width;
		lastContainerHeight = height;
		scheduleResize("observer");
	});
	resizeObserver.observe(terminalRoot);
	window.addEventListener("resize", () => scheduleResize("window"));
	document.fonts?.ready.then(() => {
		scheduleResize("fonts-ready");
	});
}

function startWebSocket(): void {
	const wsUrl = new URL("/ws", window.location.href);
	wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(wsUrl.toString());
	ws.addEventListener("open", () => {
		console.log("[web-terminal] websocket open", wsUrl.toString());
		requestAnimationFrame(() => sendResize());
	});
	ws.addEventListener("message", event => {
		let payload: unknown;
		try {
			payload = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (!payload || typeof payload !== "object") return;
		const record = payload as Record<string, unknown>;
		if (record.type === "output" && typeof record.data === "string") {
			term?.write(record.data);
			return;
		}
		if (record.type === "status") {
			const message = typeof record.message === "string" ? record.message : "";
			const state = typeof record.state === "string" ? record.state : "status";
			const text = message ? `[${state}] ${message}` : `[${state}]`;
			term?.writeln(`\r\n${text}`);
		}
	});
	ws.addEventListener("close", () => {
		term?.writeln("\r\n[disconnected] WebSocket closed.");
	});
	ws.addEventListener("error", () => {
		term?.writeln("\r\n[error] WebSocket error.");
	});
}

function initTerminal(): void {
	term = new Terminal({
		cursorBlink: true,
		fontFamily: FONT_FAMILY,
		fontSize: FONT_SIZE,
		lineHeight: 1,
		letterSpacing: 0,
		scrollback: 5000,
	});
	term.open(terminalRoot);
	term.onData(data => {
		sendMessage({ type: "input", data });
	});
}

(window as typeof window & { webTerminalDebug?: () => void }).webTerminalDebug = () => {
	console.log("[web-terminal] debug", {
		cols: term?.cols,
		rows: term?.rows,
		sizing: collectSizing(),
	});
};

function boot(): void {
	initTerminal();
	attachResizeHooks();
	startWebSocket();
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			sendResize();
		});
	});
}

if (document.readyState === "complete") {
	boot();
} else {
	window.addEventListener("load", boot, { once: true });
}

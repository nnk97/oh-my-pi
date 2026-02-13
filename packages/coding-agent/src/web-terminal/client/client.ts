import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const terminalElement = document.getElementById("terminal");
if (!terminalElement) {
	throw new Error("Terminal container not found");
}

const term = new Terminal({
	cursorBlink: true,
	fontFamily: "inherit",
	scrollback: 5000,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(terminalElement);
let terminalReady = false;

function safeFit(): void {
	if (!terminalReady) return;
	try {
		fitAddon.fit();
	} catch {
		// Ignore fit errors before viewport is ready.
	}
}

const wsUrl = new URL("/ws", window.location.href);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(wsUrl.toString());

function sendMessage(payload: object): void {
	if (ws.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify(payload));
}

function sendResize(): void {
	safeFit();
	sendMessage({ type: "resize", cols: term.cols, rows: term.rows });
}

let resizeTimer: number | null = null;
function scheduleResize(): void {
	if (!terminalReady) return;
	if (resizeTimer !== null) {
		window.clearTimeout(resizeTimer);
	}
	resizeTimer = window.setTimeout(() => {
		resizeTimer = null;
		sendResize();
	}, 80);
}

const resizeObserver = new ResizeObserver(() => {
	scheduleResize();
});
resizeObserver.observe(terminalElement);
window.addEventListener("resize", scheduleResize);

term.onData(data => {
	sendMessage({ type: "input", data });
});

ws.addEventListener("open", () => {
	console.log("[web-terminal] websocket open", wsUrl.toString());
	if (terminalReady) {
		requestAnimationFrame(() => {
			sendResize();
		});
	}
});

window.addEventListener("load", () => {
	terminalReady = true;
	requestAnimationFrame(() => {
		sendResize();
	});
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
		console.log("[web-terminal] output", { length: record.data.length });
		term.write(record.data);
		return;
	}
	if (record.type === "status") {
		const message = typeof record.message === "string" ? record.message : "";
		const state = typeof record.state === "string" ? record.state : "status";
		console.log("[web-terminal] status", { state, message });
		const text = message ? `[${state}] ${message}` : `[${state}]`;
		term.writeln(`\r\n${text}`);
	}
});

ws.addEventListener("close", () => {
	console.log("[web-terminal] websocket closed");
	term.writeln("\r\n[disconnected] WebSocket closed.");
});

ws.addEventListener("error", () => {
	console.log("[web-terminal] websocket error");
	term.writeln("\r\n[error] WebSocket error.");
});

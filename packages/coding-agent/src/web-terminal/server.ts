import * as path from "node:path";
import * as url from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage, ServerStatusState } from "./protocol";
import { parseClientMessage, serializeServerMessage } from "./protocol";
import { getActiveWebTerminalBridge, type WebTerminalBridge } from "./terminal-bridge";

export interface WebTerminalServerOptions {
	host?: string;
	port?: number;
	cwd?: string;
}

type WebTerminalSocketData = { sessionId: number | null };

type WebTerminalAsset = {
	content: string;
	contentType: string;
};

type WebTerminalClientConfig = {
	fontFamily?: string;
	fontSize?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 21357;

export class WebTerminalServer {
	#server: Server<WebTerminalSocketData>;
	#assets: Map<string, WebTerminalAsset>;
	#activeSocket: ServerWebSocket<WebTerminalSocketData> | null = null;
	#activeBridge: WebTerminalBridge | null = null;
	#activeBridgeUnsubscribe: (() => void) | null = null;
	#activeSessionId = 0;
	#cwd: string;
	readonly url: string;

	private constructor(
		server: Server<WebTerminalSocketData>,
		assets: Map<string, WebTerminalAsset>,
		url: string,
		cwd: string,
	) {
		this.#server = server;
		this.#assets = assets;
		this.url = url;
		this.#cwd = cwd;
	}

	static async start(options: WebTerminalServerOptions = {}): Promise<WebTerminalServer> {
		const host = options.host ?? DEFAULT_HOST;
		const port = options.port ?? DEFAULT_PORT;
		const cwd = options.cwd ?? process.cwd();
		const assets = await buildAssets();
		const url = `http://${host}:${port}`;
		let instance!: WebTerminalServer;
		const server = Bun.serve<WebTerminalSocketData>({
			hostname: host,
			port,
			fetch: (req, serverInstance) => instance.#handleFetch(req, serverInstance),
			websocket: {
				open: ws => instance.#handleOpen(ws),
				message: (ws, message) => instance.#handleMessage(ws, normalizeMessage(message)),
				close: ws => instance.#handleClose(ws),
			},
		});

		instance = new WebTerminalServer(server, assets, url, cwd);
		logger.debug("Web terminal server started", { url, host, port, cwd });
		return instance;
	}

	stop(): void {
		this.#server.stop();
		this.#activeSocket = null;
		this.#activeBridgeUnsubscribe?.();
		this.#activeBridgeUnsubscribe = null;
		this.#activeBridge = null;
		logger.debug("Web terminal server stopped", { url: this.url });
	}

	get isRunning(): boolean {
		return this.#server !== undefined;
	}

	#canAcceptClient(): boolean {
		return !this.#activeSocket || this.#activeSocket.readyState !== WebSocket.OPEN;
	}

	#attachSocket(ws: ServerWebSocket<WebTerminalSocketData>): void {
		this.#activeSocket = ws;
	}

	#handleFetch(req: Request, server: Server<WebTerminalSocketData>): Response | undefined {
		const requestUrl = new URL(req.url);
		if (requestUrl.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}
		if (requestUrl.pathname === "/ws") {
			logger.debug("Web terminal websocket upgrade requested", { url: req.url });
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade.", { status: 400 });
			}
			if (!this.#canAcceptClient()) {
				logger.warn("Web terminal websocket rejected (already active)");
				return new Response("Web terminal already connected.", { status: 409 });
			}
			const upgraded = server.upgrade(req, { data: { sessionId: null } });
			if (!upgraded) {
				logger.error("Web terminal websocket upgrade failed");
				return new Response("WebSocket upgrade failed.", { status: 400 });
			}
			return undefined;
		}
		const asset = this.#assets.get(requestUrl.pathname);
		if (!asset) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(asset.content, {
			headers: {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			},
		});
	}

	#handleOpen(ws: ServerWebSocket<WebTerminalSocketData>): void {
		if (!this.#canAcceptClient()) {
			ws.close(1008, "Only one client allowed");
			return;
		}
		logger.debug("Web terminal client connected");
		void this.#startSession(ws);
	}

	async #startSession(ws: ServerWebSocket<WebTerminalSocketData>): Promise<void> {
		if (!this.#canAcceptClient()) {
			this.#sendStatus(ws, "error", "Web terminal is already in use.");
			ws.close();
			return;
		}
		const bridge = getActiveWebTerminalBridge();
		if (!bridge) {
			this.#sendStatus(ws, "error", "No active terminal session to mirror.");
			ws.close();
			return;
		}
		this.#attachSocket(ws);
		const sessionId = ++this.#activeSessionId;
		ws.data.sessionId = sessionId;
		this.#activeBridge = bridge;
		this.#activeBridgeUnsubscribe?.();
		this.#activeBridgeUnsubscribe = bridge.onOutput(data => {
			if (ws.data.sessionId !== sessionId) return;
			this.#send(ws, { type: "output", data });
		});
		this.#sendStatus(ws, "running", "Connected to host terminal.");
		bridge.requestFullRender({ clear: true });
		logger.debug("Web terminal attached", {
			cwd: this.#cwd,
			size: bridge.getSize(),
		});
	}

	#handleMessage(ws: ServerWebSocket<WebTerminalSocketData>, message: ClientMessage | null): void {
		if (!message) {
			this.#sendStatus(ws, "error", "Malformed message received.");
			logger.warn("Web terminal received malformed message");
			return;
		}
		if (!this.#activeBridge || ws.data.sessionId !== this.#activeSessionId) {
			return;
		}
		if (message.type === "input") {
			logger.debug("Web terminal input", { length: message.data.length });
			try {
				this.#activeBridge.injectInput(message.data);
			} catch (error) {
				this.#sendStatus(ws, "error", error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (message.type === "resize") {
			logger.debug("Web terminal resize", { cols: message.cols, rows: message.rows });
			try {
				const cols = Math.max(1, Math.floor(message.cols));
				const rows = Math.max(1, Math.floor(message.rows));
				this.#activeBridge.setSize(cols, rows);
				this.#activeBridge.requestFullRender({ clear: true });
				logger.debug("Web terminal size applied", { cols, rows });
			} catch (error) {
				this.#sendStatus(ws, "error", error instanceof Error ? error.message : String(error));
			}
		}
	}

	#handleClose(ws: ServerWebSocket<WebTerminalSocketData>): void {
		if (this.#activeSocket === ws) {
			this.#activeSocket = null;
		}
		ws.data.sessionId = null;
		logger.debug("Web terminal client disconnected");
		this.#activeBridgeUnsubscribe?.();
		this.#activeBridgeUnsubscribe = null;
		this.#activeBridge?.clearSize();
		this.#activeBridge?.requestFullRender({ clear: true });
		logger.debug("Web terminal size cleared", { size: this.#activeBridge?.getSize() });
		this.#activeBridge = null;
	}

	#send(ws: ServerWebSocket<WebTerminalSocketData>, message: ServerMessage): void {
		try {
			ws.send(serializeServerMessage(message));
		} catch (error) {
			logger.warn("Failed to send web terminal message", { error: String(error) });
		}
	}

	#sendStatus(ws: ServerWebSocket<WebTerminalSocketData>, state: ServerStatusState, message?: string): void {
		this.#send(ws, { type: "status", state, message });
	}
}

let cachedServer: WebTerminalServer | null = null;

export async function getOrStartWebTerminalServer(options: WebTerminalServerOptions = {}): Promise<WebTerminalServer> {
	if (cachedServer) return cachedServer;
	cachedServer = await WebTerminalServer.start(options);
	return cachedServer;
}

export function getWebTerminalServer(): WebTerminalServer | null {
	return cachedServer;
}

async function buildAssets(): Promise<Map<string, WebTerminalAsset>> {
	const assetMap = new Map<string, WebTerminalAsset>();
	const clientDir = path.join(import.meta.dir, "client");
	const htmlPath = path.join(clientDir, "index.html");
	const cssPath = path.join(clientDir, "styles.css");
	const clientEntry = path.join(clientDir, "client.ts");
	const html = await Bun.file(htmlPath).text();
	const css = await Bun.file(cssPath).text();
	const clientConfig = getWebTerminalClientConfig();
	const configScript = `<script>window.__OMP_WEB_TERMINAL_CONFIG=${JSON.stringify(clientConfig).replace(/</g, "\\u003c")};</script>`;
	const htmlWithConfig = html.replace("</head>", `${configScript}</head>`);
	const xtermCssPath = resolveModulePath("@xterm/xterm/css/xterm.css");
	const xtermCss = await Bun.file(xtermCssPath).text();

	const build = await Bun.build({
		entrypoints: [clientEntry],
		format: "esm",
		splitting: false,
		target: "browser",
		minify: true,
		sourcemap: "none",
	});
	if (!build.success) {
		const messages = build.logs.map(log => log.message).join("\n");
		throw new Error(`Failed to build web terminal client.\n${messages}`);
	}
	const scriptOutput = build.outputs.find(outputFile => outputFile.path.endsWith(".js")) ?? build.outputs[0];
	if (!scriptOutput) {
		throw new Error("Failed to locate web terminal client bundle.");
	}
	const clientScript = await scriptOutput.text();

	assetMap.set("/", { content: htmlWithConfig, contentType: "text/html" });
	assetMap.set("/index.html", { content: htmlWithConfig, contentType: "text/html" });
	assetMap.set("/client.js", { content: clientScript, contentType: "text/javascript" });
	assetMap.set("/styles.css", { content: css, contentType: "text/css" });
	assetMap.set("/xterm.css", { content: xtermCss, contentType: "text/css" });
	return assetMap;
}

function getWebTerminalClientConfig(): WebTerminalClientConfig {
	const config: WebTerminalClientConfig = {};
	const fontFamily = Bun.env.OMP_WEB_TERMINAL_FONT?.trim();
	if (fontFamily) {
		config.fontFamily = fontFamily;
	}
	const fontSizeText = Bun.env.OMP_WEB_TERMINAL_FONT_SIZE?.trim();
	if (fontSizeText) {
		const parsed = Number(fontSizeText);
		if (Number.isFinite(parsed)) {
			config.fontSize = Math.max(8, Math.min(24, Math.round(parsed)));
		}
	}
	return config;
}

function resolveModulePath(specifier: string): string {
	const resolved = import.meta.resolve(specifier);
	return url.fileURLToPath(resolved);
}

function normalizeMessage(message: string | Uint8Array | ArrayBuffer): ClientMessage | null {
	const text =
		typeof message === "string"
			? message
			: message instanceof ArrayBuffer
				? new TextDecoder().decode(new Uint8Array(message))
				: new TextDecoder().decode(message);
	return parseClientMessage(text);
}

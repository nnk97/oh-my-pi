export type ClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

export type ServerStatusState = "starting" | "running" | "exited" | "error";

export type ServerMessage =
	| { type: "output"; data: string }
	| { type: "status"; state: ServerStatusState; message?: string };

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseClientMessage(raw: string): ClientMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (record.type === "input") {
		return typeof record.data === "string" ? { type: "input", data: record.data } : null;
	}
	if (record.type === "resize") {
		return isNumber(record.cols) && isNumber(record.rows)
			? { type: "resize", cols: record.cols, rows: record.rows }
			: null;
	}
	return null;
}

export function serializeServerMessage(message: ServerMessage): string {
	return JSON.stringify(message);
}

export type ClientCapabilities = {
	fontFamilyConfigured: string;
	fontFamilyResolved: string;
	fontSize: number;
	fontMatch: "exact" | "fallback" | "unknown";
	supportsNerdSymbols: boolean;
	supportsTokenEmoji: boolean;
};

export type ClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| ({ type: "client_capabilities" } & ClientCapabilities);

export type ServerStatusState = "starting" | "running" | "exited" | "error";

export type ServerMessage =
	| { type: "output"; data: string }
	| { type: "status"; state: ServerStatusState; message?: string };

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isFontMatch(value: unknown): value is ClientCapabilities["fontMatch"] {
	return value === "exact" || value === "fallback" || value === "unknown";
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
	if (record.type === "client_capabilities") {
		const fontFamilyConfigured = record.fontFamilyConfigured;
		const fontFamilyResolved = record.fontFamilyResolved;
		const fontSize = record.fontSize;
		const fontMatch = record.fontMatch;
		const supportsNerdSymbols = record.supportsNerdSymbols;
		const supportsTokenEmoji = record.supportsTokenEmoji;
		if (
			typeof fontFamilyConfigured === "string" &&
			typeof fontFamilyResolved === "string" &&
			isNumber(fontSize) &&
			isFontMatch(fontMatch) &&
			typeof supportsNerdSymbols === "boolean" &&
			typeof supportsTokenEmoji === "boolean"
		) {
			return {
				type: "client_capabilities",
				fontFamilyConfigured,
				fontFamilyResolved,
				fontSize,
				fontMatch,
				supportsNerdSymbols,
				supportsTokenEmoji,
			};
		}
		return null;
	}
	return null;
}

export function serializeServerMessage(message: ServerMessage): string {
	return JSON.stringify(message);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
	pageBytes: 25 * 1024 * 1024,
	pageFiles: 200,
	pathLength: 256,
	temporaryPages: 100,
	permanentPages: 25,
	totalBytes: 2 * 1024 * 1024 * 1024,
	minTtl: 5 * MINUTE,
	maxTtl: 30 * DAY,
	defaultTtl: DAY,
	/** How long a deleted or expired page answers 410 before it becomes a plain 404. */
	goneGrace: 7 * DAY,
} as const;

/** An error that's safe to show to the caller, with the HTTP status to show it with. */
export class PageError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Milliseconds, or "permanent" for a page that never expires. */
export type Ttl = number | "permanent";

const UNITS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY };

/**
 * Parses a TTL as given by an agent: "permanent", a duration like "30m", "2h"
 * or "7d", or a bare number of seconds. Omitted means the 24-hour default.
 */
export function parseTtl(input: string | number | undefined | null): Ttl {
	if (input === undefined || input === null || input === "") return LIMITS.defaultTtl;
	if (input === "permanent") return "permanent";
	let ms: number;
	if (typeof input === "number") {
		ms = input * 1000;
	} else {
		const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(input.trim());
		if (!match) throw new PageError(400, `Invalid ttl "${input}": use "permanent", a number of seconds, or a duration like "30m", "2h", "7d"`);
		ms = Number(match[1]) * UNITS[(match[2] || "s").toLowerCase()]!;
	}
	if (!Number.isFinite(ms) || ms < LIMITS.minTtl || ms > LIMITS.maxTtl) {
		throw new PageError(400, `ttl must be between ${durationText(LIMITS.minTtl)} and ${durationText(LIMITS.maxTtl)}, or "permanent"`);
	}
	return Math.round(ms);
}

/** The public URL of a page. */
export function pageUrl(host: string, id: string): string {
	return `https://${host}/${id}/`;
}

/** A byte count for people: "512 B", "1.5 KB", "25 MB", "2 GB". */
export function bytesText(n: number): string {
	const fixed = (value: number, digits: number) => value.toFixed(digits).replace(/\.0+$/, "");
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${fixed(n / 1024, 1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${fixed(n / 1024 / 1024, 1)} MB`;
	return `${fixed(n / 1024 / 1024 / 1024, 2)} GB`;
}

/** A whole number of minutes, hours or days for people: "5 minutes", "30 days". */
export function durationText(ms: number): string {
	for (const [unit, size] of [
		["day", DAY],
		["hour", HOUR],
		["minute", MINUTE],
	] as const) {
		if (ms >= size && ms % size === 0) return `${ms / size} ${unit}${ms === size ? "" : "s"}`;
	}
	return `${Math.round(ms / 1000)} seconds`;
}

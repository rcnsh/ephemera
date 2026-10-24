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
		throw new PageError(400, "ttl must be between 5 minutes and 30 days, or \"permanent\"");
	}
	return Math.round(ms);
}

const encoder = new TextEncoder();

async function digest(text: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

/** Compares two strings in constant time (hashing first makes the lengths equal). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

/** True when the request carries `Authorization: Bearer <EPHEMERA_TOKEN>`. */
export async function hasToken(request: Request, token: string): Promise<boolean> {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return !!match && !!token && (await safeEqual(match[1]!.trim(), token));
}

async function hmac(key: string, message: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
	return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/[+/=]/g, "");
}

/**
 * A capability to upload new files for one page until `expiresAt`, so an
 * agent can hand a zip to curl without the bearer token. Ends in an HMAC of
 * the rest, keyed by the Worker's token.
 */
export async function uploadToken(secret: string, id: string, expiresAt: number): Promise<string> {
	const exp = expiresAt.toString(36);
	return `${id}.${exp}.${await hmac(secret, `upload:${id}:${exp}`)}`;
}

/** The page id an upload token is for, or null if it's forged or expired. */
export async function checkUploadToken(secret: string, token: string, now = Date.now()): Promise<string | null> {
	const [id, exp, signature, ...rest] = token.split(".");
	if (!id || !exp || !signature || rest.length || !secret) return null;
	if (!(await safeEqual(signature, await hmac(secret, `upload:${id}:${exp}`)))) return null;
	return parseInt(exp, 36) > now ? id : null;
}

const CSRF_WINDOW = 12 * 60 * 60 * 1000;

/** A CSRF token for the dashboard, tied to the signed-in user and valid for 12 to 24 hours. */
export function csrfToken(secret: string, user: string, now = Date.now()): Promise<string> {
	return hmac(secret, `csrf:${user}:${Math.floor(now / CSRF_WINDOW)}`);
}

export async function checkCsrf(secret: string, user: string, token: string, now = Date.now()): Promise<boolean> {
	for (const at of [now, now - CSRF_WINDOW]) {
		if (await safeEqual(token, await csrfToken(secret, user, at))) return true;
	}
	return false;
}

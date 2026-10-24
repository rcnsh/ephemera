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

/**
 * A pass to view private page `id` until `expiresAt`. It goes in the path,
 * `/<id>/~<pass>/`, so the page's relative links carry it without cookies,
 * which a sandboxed page's own requests wouldn't send. `epoch` is the page's
 * share_epoch: bumping it revokes every pass.
 */
export async function viewPass(secret: string, id: string, epoch: number, expiresAt: number): Promise<string> {
	const exp = expiresAt.toString(36);
	return `~${exp}.${await hmac(secret, `view:${id}:${epoch}:${exp}`)}`;
}

export const PASS_PATTERN = /^~[0-9a-z]+\.[A-Za-z0-9]+$/;

export async function checkViewPass(secret: string, id: string, epoch: number, pass: string, now = Date.now()): Promise<boolean> {
	if (!PASS_PATTERN.test(pass) || !secret) return false;
	const [exp, signature] = pass.slice(1).split(".") as [string, string];
	if (!(await safeEqual(signature, await hmac(secret, `view:${id}:${epoch}:${exp}`)))) return false;
	return parseInt(exp, 36) > now;
}

const PBKDF2_ITERATIONS = 100_000;

function base64(bytes: ArrayBuffer | Uint8Array): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** `pbkdf2$<iterations>$<salt>$<hash>`, for storing. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${PBKDF2_ITERATIONS}$${base64(salt)}$${base64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, iterations, salt, hash] = stored.split("$");
	if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
	const derived = await pbkdf2(password, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), Number(iterations));
	return safeEqual(base64(derived), hash);
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

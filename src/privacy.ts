import { checkPassword, checkViewPass, PASS_PATTERN, viewPass } from "./auth.ts";
import { LIMITS, pageUrl } from "./domain.ts";
import { FAVICON_LINK } from "./logo.ts";
import type { Page, Pages } from "./pages.ts";

/**
 * Who may see a page, and through which URL. Public pages are served to
 * anyone at `/<id>/`. A private page needs a pass as its first path segment,
 * `/<id>/~<pass>/`; without one it answers with a gate: a link to sign in
 * through Access on the dashboard host, and a password form if the page has a
 * password. Both hand out a pass and redirect behind it.
 *
 * `access` decides how to answer a request for a page; `viewerUrl` hands out
 * a URL to open one. Nothing else needs to know what a pass looks like.
 */

/** How to answer a request for a path of a live page. */
export type Access =
	/** Serve `rest` (the path inside the page). Relative links resolve under `base`, which carries `pass`. */
	| { kind: "serve"; rest: string; base: string; pass: string | null }
	| { kind: "redirect"; location: string }
	/** Answer with `gate(env, page, rest, message)`. */
	| { kind: "gate"; rest: string; message?: string };

/**
 * How to answer a request for `subpath` (the path after `/<id>/`, with
 * `search` its query string) of `page` at time `now`.
 */
export async function access(secret: string, page: Page, subpath: string, search: string, now: number): Promise<Access> {
	const [first = "", ...after] = subpath.split("/");
	if (PASS_PATTERN.test(first)) {
		const rest = after.join("/");
		// A pass on a page that has since been made public: drop it.
		if (page.visibility === "public") return { kind: "redirect", location: `/${page.id}/${safeRest(page.id, rest)}${search}` };
		if (!(await checkViewPass(secret, page.id, page.shareEpoch, first, now))) return { kind: "gate", rest, message: "This link has expired or been revoked." };
		// Without the slash after the pass, relative links would drop it.
		if (after.length === 0) return { kind: "redirect", location: `/${page.id}/${first}/${search}` };
		return { kind: "serve", rest, base: `/${page.id}/${first}`, pass: first };
	}
	if (page.visibility === "private") return { kind: "gate", rest: subpath };
	return { kind: "serve", rest: subpath, base: `/${page.id}`, pass: null };
}

/**
 * A URL that opens `page` at path `rest` inside it: the plain URL of a public
 * page, or a private page's behind a fresh pass that lasts `ttl` from `now`
 * (by default as long as signing in does). A `rest` that could leave the page
 * is dropped. Without a `rest` it ends in "/", so a relative path can follow.
 */
export async function viewerUrl(secret: string, host: string, page: Page, now: number, { rest = "", ttl = LIMITS.passTtl }: { rest?: string; ttl?: number } = {}): Promise<string> {
	if (page.visibility === "public") return `${pageUrl(host, page.id)}${safeRest(page.id, rest)}`;
	const pass = await viewPass(secret, page.id, page.shareEpoch, now + ttl);
	return `${pageUrl(host, page.id)}${pass}/${safeRest(page.id, rest)}`;
}

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Keeps a path that gets passed along inside page `id`, or "" if it could
 * leave. Rather than look for bad strings, it resolves the path the way a URL
 * parser will (which reads "%2e%2e" as ".." and drops tabs and newlines) under
 * a folder of the page, and keeps it only if it stays in that folder.
 * Whitespace, control characters, backslashes and "." or ".." segments, plain
 * or percent-encoded, are refused outright: callers append the path under
 * different folders (`/<id>/`, `/<id>/~pass/`, `/open/<id>/`), so one that
 * climbs out and back in ("%2e%2e/_/x") must not pass.
 */
function safeRest(id: string, rest: string): string {
	const clean = rest.replace(/^\/+/, "");
	if (/[\s\u0000-\u001f\u007f\\]/.test(clean) || clean.split(/[/?#]/).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return "";
	const folder = `/${id}/_/`;
	const resolved = new URL(`https://page.invalid${folder}${clean}`);
	return resolved.origin === "https://page.invalid" && resolved.pathname.startsWith(folder) ? clean : "";
}

export function gate(env: Env, page: Page, rest: string, message = "", status = 401): Response {
	const next = escape(safeRest(page.id, rest));
	const signIn = `https://${env.ADMIN_HOST}/open/${page.id}/${next}`;
	const password = page.passwordHash
		? `<form method="post" action="/${page.id}/_unlock">
<input type="hidden" name="next" value="${next}">
<label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button>Open</button>
</form>
<p class="or">or</p>`
		: "";
	return new Response(
		`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private page</title>
${FAVICON_LINK}
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.2rem; }
.message { color: #b00; }
.or { color: #888; }
input, button { font: inherit; }
a { color: #0645ad; }
@media (prefers-color-scheme: dark) { body { color: #ddd; background: #161616; } a { color: #8ab4f8; } }
</style>
<h1>This page is private</h1>
${message ? `<p class="message">${escape(message)}</p>` : ""}
${password}
<p><a href="${signIn}">Sign in to open it</a></p>
</html>
`,
		{ status, headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

/** POST /<id>/_unlock: checks the password and redirects behind a fresh pass. */
export async function unlock(request: Request, env: Env, pages: Pages, id: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live") return new Response("Not found\n", { status: found.state === "gone" ? 410 : 404 });
	const page = found.page;
	const form = await request.formData().catch(() => new FormData());
	const next = String(form.get("next") ?? "");
	const open = () => viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, page, Date.now(), { rest: next });
	if (page.visibility !== "private") return Response.redirect(await open(), 303);
	const password = String(form.get("password") ?? "");
	if (!page.passwordHash || !password) return gate(env, page, next, "Wrong password");
	// Checked before the hash, which is the expensive part of a guess.
	if (!(await mayGuess(request, env, page.id))) {
		const limited = gate(env, page, next, "Too many password attempts. Try again in a minute, or sign in instead.", 429);
		limited.headers.set("retry-after", String(GUESS_PERIOD));
		return limited;
	}
	if (!(await checkPassword(password, page.passwordHash))) return gate(env, page, next, "Wrong password");
	return Response.redirect(await open(), 303);
}

/** The window, in seconds, of both guess limits in cloudflare.config.ts. */
const GUESS_PERIOD = 60;

/**
 * Whether another password guess at page `id` may be checked: each client
 * address gets 5 a minute (PASSWORD_GUESSES), and the page 30 a minute from
 * everyone (PAGE_PASSWORD_GUESSES), so many addresses can't guess freely
 * either. Both are per Cloudflare location and lift a minute after the
 * guessing stops; signing in and share links aren't limited.
 */
async function mayGuess(request: Request, env: Env, id: string): Promise<boolean> {
	// Set by Cloudflare on every request; a client can't choose it.
	const client = request.headers.get("cf-connecting-ip") ?? "unknown";
	try {
		if (!(await env.PASSWORD_GUESSES.limit({ key: `${id}:${client}` })).success) return false;
		return (await env.PAGE_PASSWORD_GUESSES.limit({ key: id })).success;
	} catch (error) {
		// A limiter that's missing or failing refuses the guess, and the gate still offers signing in.
		console.error("Password guess limiter failed", error);
		return false;
	}
}

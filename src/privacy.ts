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
		if (page.visibility === "public") return { kind: "redirect", location: `/${page.id}/${safeRest(rest)}${search}` };
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
	if (page.visibility === "public") return `${pageUrl(host, page.id)}${safeRest(rest)}`;
	const pass = await viewPass(secret, page.id, page.shareEpoch, now + ttl);
	return `${pageUrl(host, page.id)}${pass}/${safeRest(rest)}`;
}

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Keeps a path that gets passed along inside the page. It's checked decoded,
 * since URL parsers treat "%2e%2e" as "..".
 */
function safeRest(rest: string): string {
	const clean = rest.replace(/^\/+/, "");
	let decoded: string;
	try {
		decoded = decodeURIComponent(clean);
	} catch {
		return "";
	}
	return decoded.split("/").some((segment) => segment === ".." || segment === ".") || decoded.includes("\\") ? "" : clean;
}

export function gate(env: Env, page: Page, rest: string, message = "", status = 401): Response {
	const next = escape(safeRest(rest));
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
	if (!page.passwordHash || !password || !(await checkPassword(password, page.passwordHash))) {
		return gate(env, page, next, "Wrong password");
	}
	return Response.redirect(await open(), 303);
}

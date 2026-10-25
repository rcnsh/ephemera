import { checkPassword, viewPass } from "./auth.ts";
import { LIMITS } from "./domain.ts";
import { FAVICON_LINK } from "./logo.ts";
import type { Page, Pages } from "./pages.ts";

/**
 * Private pages. Without a pass in its path a private page answers with a
 * gate: a link to sign in through Access on the dashboard host, and a
 * password form if the page has a password. Both hand out a pass and
 * redirect to `/<id>/~<pass>/`.
 */

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Keeps a path that gets passed along inside the page. */
export function safeRest(rest: string): string {
	const clean = rest.replace(/^\/+/, "");
	return clean.split("/").some((segment) => segment === ".." || segment === ".") || clean.includes("\\") ? "" : clean;
}

/** The URL of a private page (or a path in it) behind `pass`. */
export function passUrl(host: string, id: string, pass: string, rest = ""): string {
	return `https://${host}/${id}/${pass}/${safeRest(rest)}`;
}

/** Mints a pass for `page`, valid for `ttl` (the default for people signing in). */
export function passFor(secret: string, page: Page, now: number, ttl: number = LIMITS.passTtl): Promise<string> {
	return viewPass(secret, page.id, page.shareEpoch, now + ttl);
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
	if (page.visibility !== "private") return Response.redirect(`https://${env.PAGES_HOST}/${id}/${safeRest(next)}`, 303);
	const password = String(form.get("password") ?? "");
	if (!page.passwordHash || !password || !(await checkPassword(password, page.passwordHash))) {
		return gate(env, page, next, "Wrong password");
	}
	return Response.redirect(passUrl(env.PAGES_HOST, id, await passFor(env.EPHEMERA_TOKEN, page, Date.now()), next), 303);
}

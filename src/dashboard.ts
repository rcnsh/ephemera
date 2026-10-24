import { checkCsrf, csrfToken } from "./auth.ts";
import { LIMITS, PageError } from "./limits.ts";
import type { Page, Pages, Usage } from "./pages.ts";

const EXTENSIONS: Record<string, number> = { "1h": 3_600_000, "1d": 86_400_000, "7d": 7 * 86_400_000 };

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function duration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const CSS = `
body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #222; background: #fafafa; }
h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
.usage { color: #666; margin: 0 0 1.5rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
th { font-weight: 600; color: #666; }
td.actions { white-space: nowrap; }
form { display: inline; margin: 0; }
button { font: inherit; cursor: pointer; background: none; border: 1px solid #bbb; border-radius: 3px; padding: 0 .4rem; color: inherit; }
button:hover { background: #eee; }
details { display: inline; }
summary { display: inline; cursor: pointer; color: #b00; }
.danger { border-color: #b00; color: #b00; }
.muted { color: #888; }
a { color: #0645ad; }
@media (prefers-color-scheme: dark) {
	body { color: #ddd; background: #161616; }
	th, td { border-color: #333; }
	button { border-color: #555; }
	button:hover { background: #2a2a2a; }
	a { color: #8ab4f8; }
}
`;

const SCRIPT = `
for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText(button.dataset.copy);
		button.textContent = "copied";
		setTimeout(() => (button.textContent = "copy"), 1200);
	});
}
`;

function row(page: Page, host: string, csrf: string, now: number): string {
	const url = `https://${host}/${page.id}/`;
	const action = (path: string, label: string, cls = "") =>
		`<form method="post" action="/pages/${page.id}/${path}"><input type="hidden" name="csrf" value="${csrf}"><button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
	const extend = Object.keys(EXTENSIONS)
		.map((by) => action(`extend?by=${by}`, `+${by}`))
		.join(" ");
	return `<tr>
<td>${page.label ? escape(page.label) : '<span class="muted">—</span>'}</td>
<td>${page.agent ? escape(page.agent) : '<span class="muted">—</span>'}</td>
<td><a href="${url}" target="_blank" rel="noopener noreferrer">${page.id}</a> <button type="button" data-copy="${url}">copy</button></td>
<td>${duration(now - page.createdAt)} ago</td>
<td>${page.permanent ? "permanent" : duration(page.expiresAt! - now)}</td>
<td>${bytes(page.size)} · ${page.fileCount} file${page.fileCount === 1 ? "" : "s"}</td>
<td class="actions">${page.permanent ? action("temporary", "make temporary") : `${extend} ${action("permanent", "make permanent")}`}
<details><summary>delete</summary> ${action("delete", "really delete", "danger")}</details></td>
</tr>`;
}

function render(pages: Page[], usage: Usage, host: string, csrf: string, nonce: string, now: number): string {
	const rows = pages.map((page) => row(page, host, csrf, now)).join("\n");
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ephemera</title>
<style nonce="${nonce}">${CSS}</style>
<h1>ephemera</h1>
<p class="usage">${usage.temporaryPages} / ${LIMITS.temporaryPages} temporary · ${usage.permanentPages} / ${LIMITS.permanentPages} permanent · ${bytes(usage.bytes)} / 2 GB</p>
${
	pages.length
		? `<table>
<thead><tr><th>Label</th><th>Agent</th><th>Page</th><th>Created</th><th>Expires in</th><th>Size</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
		: '<p class="muted">No live pages.</p>'
}
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function respond(body: string, status: number, nonce = ""): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

/** The admin dashboard on ADMIN_HOST. Only reachable through the Cloudflare Access app with audience ACCESS_AUD. */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return respond("Forbidden", 403);
	const identity = await ctx.access.getIdentity().catch(() => undefined);
	const user = String((identity as { email?: string } | undefined)?.email ?? "owner");
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/") {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		const [list, usage] = await Promise.all([pages.list(), pages.usage()]);
		const csrf = await csrfToken(env.EPHEMERA_TOKEN, user);
		return respond(render(list, usage, env.PAGES_HOST, csrf, nonce, Date.now()), 200, nonce);
	}

	const match = /^\/pages\/([a-z2-7]{12})\/(extend|permanent|temporary|delete)$/.exec(url.pathname);
	if (request.method !== "POST" || !match) return respond("Not found", 404);

	const form = await request.formData().catch(() => new FormData());
	const origin = request.headers.get("origin");
	if (origin !== `https://${env.ADMIN_HOST}` || !(await checkCsrf(env.EPHEMERA_TOKEN, user, String(form.get("csrf") ?? "")))) {
		return respond("Forbidden: reload the dashboard and try again", 403);
	}

	const [, id, action] = match as unknown as [string, string, string];
	try {
		if (action === "extend") {
			const by = EXTENSIONS[url.searchParams.get("by") ?? ""];
			if (!by) return respond("Unknown extension", 400);
			await pages.extend(id, by);
		} else if (action === "permanent") {
			await pages.extend(id, "permanent");
		} else if (action === "temporary") {
			await pages.makeTemporary(id);
		} else {
			await pages.delete(id);
		}
	} catch (error) {
		if (error instanceof PageError) return respond(`${escape(error.message)} <a href="/">back</a>`, error.status);
		throw error;
	}
	return new Response(null, { status: 303, headers: { location: "/" } });
}

import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN, call, publish } from "./helpers.ts";

afterEach(() => reset());

const AUD = "test-aud";

/** `accessAud: null` simulates a request that didn't come through Access. */
function admin(path = "/", init: RequestInit = {}, accessAud: string | null = AUD): Promise<Response> {
	return call(`${ADMIN}${path}`, init, { accessAud: accessAud ?? undefined });
}

async function csrfToken(): Promise<string> {
	const html = await (await admin()).text();
	return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}

function post(path: string, csrf: string, origin = ADMIN): Promise<Response> {
	return admin(path, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf }),
	});
}

describe("dashboard", () => {
	it("refuses requests that didn't come through Access, or for another Access app", async () => {
		expect((await admin("/", {}, null)).status).toBe(403);
		expect((await admin("/", {}, "other-app")).status).toBe(403);
	});

	it("lists live pages with usage, and isn't sandboxed or cached", async () => {
		await publish({ label: "quarterly report", agent: "codex" });
		await publish({ ttl: "permanent", label: "keeper" });
		const response = await admin();
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("quarterly report");
		expect(html).toContain("codex");
		expect(html).toContain("permanent");
		expect(html).toMatch(/1\s*\/\s*100 temporary/);
		expect(html).toMatch(/1\s*\/\s*25 permanent/);
		expect(response.headers.get("content-security-policy")).not.toMatch(/^sandbox/);
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects actions without a valid CSRF token or from another origin", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		expect((await post(`/pages/${page.id}/delete`, "forged")).status).toBe(403);
		expect((await post(`/pages/${page.id}/delete`, csrf, "https://p.rcn.sh")).status).toBe(403);
		expect((await call(page.url)).status).toBe(200);
	});

	it("extends, toggles permanent and deletes pages", async () => {
		const page = await publish({ ttl: "1h" });
		const csrf = await csrfToken();

		const extended = await post(`/pages/${page.id}/extend?by=1d`, csrf);
		expect(extended.status).toBe(303);
		expect(extended.headers.get("location")).toBe("/");

		expect((await post(`/pages/${page.id}/permanent`, csrf)).status).toBe(303);
		expect(await (await admin()).text()).toMatch(/permanent/);
		expect((await post(`/pages/${page.id}/temporary`, csrf)).status).toBe(303);

		expect((await post(`/pages/${page.id}/delete`, csrf)).status).toBe(303);
		expect((await call(page.url)).status).toBe(410);
	});
});

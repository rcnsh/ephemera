import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN, PAGES, call, publish } from "./helpers.ts";

afterEach(() => reset());

const PASSWORD = "correct horse";

describe("unlocking a private page", () => {
	it("never redirects outside the page, however the next path is encoded", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const other = await publish();
		const sneaky = [
			`.\t./.\t./${other.id}/`,
			`.\n./.\n./${other.id}/`,
			`.\r./.\r./${other.id}/`,
			`%2e\t%2e/%2e\t%2e/${other.id}/`,
			`\t../../${other.id}/`,
			`..\\..\\${other.id}/`,
			`%2e%2e/%2e%2e/${other.id}/`,
			`%2E%2E/%2E%2E/${other.id}/`,
			`.%2e/.%2e/${other.id}/`,
			`a/%2e%2e/%2e%2e/${other.id}/`,
		];
		for (const next of sneaky) {
			const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next }) });
			expect(response.status, next).toBe(303);
			const location = new URL(response.headers.get("location")!);
			expect(location.pathname, next).toMatch(new RegExp(`^/${page.id}/~[^/]+/$`));
		}
	});

	it("redirects inside the page on a public page too, without a password", async () => {
		const page = await publish();
		const other = await publish();
		for (const next of [`.\t./.\t./${other.id}/`, `.\n./.\n./${other.id}/`, `.\r./.\r./${other.id}/`, "%2e%2e/_/x", ".%2E/_/"]) {
			const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ next }) });
			expect(response.status, JSON.stringify(next)).toBe(303);
			expect(new URL(response.headers.get("location")!).pathname, JSON.stringify(next)).toBe(`/${page.id}/`);
		}
	});

	it("keeps the gate's links inside the page after a wrong password", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		for (const next of [`.\t./.\t./zzz/`, `.\n./zzz/`, `%2e%2e/zzz/`, "%2e%2e/_/x", `%2e%2e/%2e%2e/${page.id}/_/x`]) {
			const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: "wrong password", next }) });
			expect(response.status).toBe(401);
			const html = await response.text();
			expect(html, JSON.stringify(next)).toContain(`href="${ADMIN}/open/${page.id}/"`);
			expect(html, JSON.stringify(next)).toContain('name="next" value=""');
		}
	});

	it("keeps inputs that were already safe inside the page", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		for (const next of ["%252e%252e/%252e%252e/zzz/", "..\\zzz", "%5c..%5czzz", "%2E", "https://evil.example/", "//evil.example/", "?x=1", "#top", "..;/zzz/", "%2e/x", "%2e%2e%2fzzz/", "%zz/"]) {
			const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next }) });
			expect(response.status, next).toBe(303);
			const location = new URL(response.headers.get("location")!);
			expect(location.origin, next).toBe(PAGES);
			expect(location.pathname, next).toMatch(new RegExp(`^/${page.id}/~[^/]+/`));
		}
	});

	it("still follows an ordinary next path", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next: "docs/a%20b.html" }) });
		expect(new URL(response.headers.get("location")!).pathname).toMatch(new RegExp(`^/${page.id}/~[^/]+/docs/a%20b\\.html$`));
	});
});

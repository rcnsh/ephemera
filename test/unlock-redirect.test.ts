import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { PAGES, call, publish } from "./helpers.ts";

afterEach(() => reset());

const PASSWORD = "correct horse";

describe("unlocking a private page", () => {
	it("never redirects outside the page, however the next path is encoded", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const other = await publish();
		const sneaky = [`%2e%2e/%2e%2e/${other.id}/`, `%2E%2E/%2E%2E/${other.id}/`, `.%2e/.%2e/${other.id}/`, `%2e/x`, `a/%2e%2e/%2e%2e/${other.id}/`, `%2e%2e%2f${other.id}/`, `%zz/`];
		for (const next of sneaky) {
			const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next }) });
			expect(response.status, next).toBe(303);
			const location = new URL(response.headers.get("location")!);
			expect(location.pathname, next).toMatch(new RegExp(`^/${page.id}/~[^/]+/$`));
		}
	});

	it("still follows an ordinary next path", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const response = await call(`${PAGES}/${page.id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next: "docs/a%20b.html" }) });
		expect(new URL(response.headers.get("location")!).pathname).toMatch(new RegExp(`^/${page.id}/~[^/]+/docs/a%20b\\.html$`));
	});
});

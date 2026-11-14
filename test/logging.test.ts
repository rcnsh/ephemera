import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../src/logging.ts";
import { PAGES, ADMIN, call, publish } from "./helpers.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("redact", () => {
	it("hides passes in page paths", () => {
		expect(redact("/k3x7q2abcd12/~mfz1a2b.AbC123xyz/docs/a.html")).toBe("/k3x7q2abcd12/~redacted/docs/a.html");
		expect(redact("/k3x7q2abcd12/~mfz1a2b.AbC123xyz")).toBe("/k3x7q2abcd12/~redacted");
		expect(redact("/k3x7q2abcd12/%7Emfz1a2b.AbC/")).toBe("/k3x7q2abcd12/~redacted/");
		expect(redact("/k3x7q2abcd12/%7emfz1a2b.AbC/")).toBe("/k3x7q2abcd12/~redacted/");
	});

	it("hides upload tokens", () => {
		expect(redact("/upload/k3x7q2abcd12.mfz1a2b.AbC123")).toBe("/upload/redacted");
		expect(redact("/upload/k3x7q2abcd12.mfz1a2b.AbC123/extra")).toBe("/upload/redacted");
		// A page's own folder called upload isn't a token.
		expect(redact("/k3x7q2abcd12/upload/logo.png")).toBe("/k3x7q2abcd12/upload/logo.png");
	});

	it("hides them inside URLs and messages too", () => {
		expect(redact("thumbnail of https://p.example.com/k3x7q2abcd12/~mfz1a2b.AbC/ failed: net::ERR at https://p.example.com/k3x7q2abcd12/~mfz1a2b.AbC/")).toBe(
			"thumbnail of https://p.example.com/k3x7q2abcd12/~redacted/ failed: net::ERR at https://p.example.com/k3x7q2abcd12/~redacted/",
		);
		expect(redact("https://p.example.com/upload/abc.def.ghi?x=1")).toBe("https://p.example.com/upload/redacted?x=1");
	});

	it("leaves paths without secrets alone", () => {
		for (const path of ["/", "/k3x7q2abcd12/", "/api/pages/k3x7q2abcd12", "/mcp", "/open/k3x7q2abcd12/docs/", "/thumbnails/k3x7q2abcd12.png"]) {
			expect(redact(path)).toBe(path);
		}
	});
});

describe("request logs", () => {
	it("give method, host, a redacted path, status and timing, and never the pass", async () => {
		const page = await publish({ visibility: "private" });
		const link = (await (await call(`${PAGES}/api/pages/${page.id}/share`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: "{}" })).json()) as { url: string };
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect((await call(`${link.url}?q=1`)).status).toBe(200);
		await call(`${PAGES}/upload/${page.id}.zzz.forged`, { method: "PUT" });
		await call(`${ADMIN}/`);
		const lines = log.mock.calls.map((args) => args.join(" "));
		const pass = new URL(link.url).pathname.split("/")[2]!;
		expect(lines.join("\n")).not.toContain(pass.slice(1));
		expect(lines.join("\n")).not.toContain("forged");
		const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries[0]).toMatchObject({ method: "GET", host: "pages.example.com", path: `/${page.id}/~redacted/`, status: 200 });
		expect(typeof entries[0]!.ms).toBe("number");
		expect(entries[1]).toMatchObject({ method: "PUT", path: "/upload/redacted", status: 403 });
		expect(entries[2]).toMatchObject({ host: "admin.example.com", path: "/", status: 403 });
	});
});

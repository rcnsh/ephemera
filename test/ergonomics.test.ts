import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGES, api, call, publish, zip } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

function post(path: string, body: unknown, method = "POST"): Promise<Response> {
	return api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("single-page shortcuts", () => {
	it("publishes html as index.html", async () => {
		const response = await post("/pages", { html: "<h1>just html</h1>" });
		expect(response.status).toBe(201);
		const page = (await response.json()) as { url: string };
		expect(await (await call(page.url)).text()).toBe("<h1>just html</h1>");
	});

	it("renders markdown to a styled page titled by its first heading", async () => {
		const page = (await (await post("/pages", { markdown: "# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |" })).json()) as { url: string };
		const html = await (await call(page.url)).text();
		expect(html).toContain("<title>Report</title>");
		expect(html).toContain("<h1>Report</h1>");
		expect(html).toContain("<table>");
	});

	it("titles a markdown page by its label when there is one", async () => {
		const page = (await (await post("/pages", { markdown: "no heading", label: "<Notes>" })).json()) as { url: string };
		expect(await (await call(page.url)).text()).toContain("<title>&#60;Notes&#62;</title>");
	});

	it("wants exactly one kind of content", async () => {
		expect((await post("/pages", { html: "x", markdown: "y" })).status).toBe(400);
		expect((await post("/pages", {})).status).toBe(400);
	});

	it("updates with a shortcut too", async () => {
		const page = await publish();
		expect((await post(`/pages/${page.id}`, { markdown: "# v2" }, "PUT")).status).toBe(200);
		expect(await (await call(page.url)).text()).toContain("<h1>v2</h1>");
	});
});

describe("patching files", () => {
	it("adds, replaces and removes files, keeping the rest", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "<h1>hi</h1>" },
				{ path: "app.css", content: "body{}" },
				{ path: "old.js", content: "1" },
			],
		});
		const response = await post(`/pages/${page.id}/files`, { files: [{ path: "app.css", content: "body{color:red}" }, { path: "new.json", content: "{}" }], remove: ["old.js"] });
		expect(response.status).toBe(200);
		const patched = (await response.json()) as { version: number; fileCount: number };
		expect(patched).toMatchObject({ version: 2, fileCount: 3 });

		expect(await (await call(page.url)).text()).toBe("<h1>hi</h1>");
		const css = await call(`${page.url}app.css`);
		expect(await css.text()).toBe("body{color:red}");
		expect(css.headers.get("content-type")).toMatch(/^text\/css/);
		expect((await call(`${page.url}new.json`)).status).toBe(200);
		expect((await call(`${page.url}old.js`)).status).toBe(404);
		// The carried index.html keeps its content type.
		expect((await call(page.url)).headers.get("content-type")).toBe("text/html; charset=utf-8");

		// The first version is untouched, for rollback.
		await post(`/pages/${page.id}/rollback`, { version: 1 });
		expect(await (await call(`${page.url}old.js`)).text()).toBe("1");
	});

	it("refuses to remove index.html, a missing file, or one it's also writing", async () => {
		const page = await publish();
		expect((await post(`/pages/${page.id}/files`, { remove: ["index.html"] })).status).toBe(400);
		expect((await post(`/pages/${page.id}/files`, { remove: ["nope.txt"] })).status).toBe(404);
		expect((await post(`/pages/${page.id}/files`, { files: [{ path: "index.html", content: "x" }], remove: ["index.html"] })).status).toBe(400);
		expect((await post(`/pages/${page.id}/files`, { remove: "index.html" })).status).toBe(400);
	});
});

describe("upload URLs", () => {
	interface Upload {
		id: string;
		url: string;
		uploadUrl: string;
		uploadExpiresAt: number;
		command: string;
	}

	async function upload(url: string, body: Uint8Array, headers: Record<string, string> = { "content-type": "application/zip" }): Promise<Response> {
		return call(url, { method: "PUT", headers, body });
	}

	it("publishes a placeholder, then takes a zip without the bearer token", async () => {
		const response = await post("/uploads", { ttl: "2h", label: "site" });
		expect(response.status).toBe(201);
		const created = (await response.json()) as Upload;
		expect(created.uploadUrl).toMatch(new RegExp(`^${PAGES}/upload/${created.id}\\.`));
		expect(created.command).toContain(created.uploadUrl);
		expect(await (await call(created.url)).text()).toContain("Waiting");

		const uploaded = await upload(created.uploadUrl, zip({ "index.html": "<h1>uploaded</h1>", "a.css": "x" }));
		expect(uploaded.status).toBe(200);
		expect(await (await call(created.url)).text()).toBe("<h1>uploaded</h1>");

		// It can be used again until it expires.
		expect((await upload(created.uploadUrl, zip({ "index.html": "again" }))).status).toBe(200);
		expect(await (await call(created.url)).text()).toBe("again");
	});

	it("uploads new files for an existing page", async () => {
		const page = await publish();
		const created = (await (await post("/uploads", { id: page.id })).json()) as Upload;
		expect(created.id).toBe(page.id);
		await upload(created.uploadUrl, zip({ "index.html": "replaced" }));
		expect(await (await call(page.url)).text()).toBe("replaced");
	});

	it("rejects tampered and expired upload URLs", async () => {
		const page = await publish();
		const created = (await (await post("/uploads", { id: page.id })).json()) as Upload;
		const other = await publish();
		const forged = created.uploadUrl.replace(page.id, other.id);
		expect((await upload(forged, zip({ "index.html": "x" }))).status).toBe(403);
		expect((await upload(`${PAGES}/upload/nonsense`, zip({ "index.html": "x" }))).status).toBe(403);

		vi.spyOn(Date, "now").mockReturnValue(created.uploadExpiresAt + 1);
		expect((await upload(created.uploadUrl, zip({ "index.html": "x" }))).status).toBe(403);
	});

	it("only takes PUT or POST", async () => {
		const created = (await (await post("/uploads", {})).json()) as Upload;
		expect((await call(created.uploadUrl)).status).toBe(405);
	});
});

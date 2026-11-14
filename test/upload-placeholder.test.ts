import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, call, publish, zip } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

interface Upload {
	id: string;
	url: string;
	uploadUrl: string;
	uploadExpiresAt: number;
	expiresAt: number | null;
	permanent: boolean;
}

const HOUR = 3_600_000;

async function startUpload(body: Record<string, unknown>): Promise<Upload> {
	const response = await api("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	expect(response.status).toBe(201);
	return response.json();
}

function upload(url: string, files: Record<string, string>): Promise<Response> {
	return call(url, { method: "PUT", headers: { "content-type": "application/zip" }, body: zip(files) });
}

describe("upload_url's placeholder page", () => {
	it("expires with the upload URL if nothing is uploaded", async () => {
		const created = await startUpload({});
		expect(created).toMatchObject({ permanent: false, expiresAt: created.uploadExpiresAt });
		vi.spyOn(Date, "now").mockReturnValue(created.uploadExpiresAt + 1);
		expect((await call(created.url)).status).toBe(410);
	});

	it("becomes permanent when the first upload lands, if no ttl was asked for", async () => {
		const created = await startUpload({});
		const response = await upload(created.uploadUrl, { "index.html": "<h1>up</h1>" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ permanent: true, expiresAt: null });
		vi.spyOn(Date, "now").mockReturnValue(created.uploadExpiresAt + 365 * 24 * HOUR);
		expect(await (await call(created.url)).text()).toBe("<h1>up</h1>");
	});

	it("gets the ttl asked for, counted from the first upload", async () => {
		const created = await startUpload({ ttl: "2d" });
		const start = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(start + 30 * 60_000);
		const first = (await (await upload(created.uploadUrl, { "index.html": "one" })).json()) as Upload;
		expect(first).toMatchObject({ permanent: false, expiresAt: start + 30 * 60_000 + 48 * HOUR });

		// Later uploads, each with a URL of its own, leave the expiry alone.
		vi.spyOn(Date, "now").mockReturnValue(start + 40 * 60_000);
		const again = await startUpload({ id: created.id });
		const second = (await (await upload(again.uploadUrl, { "index.html": "two" })).json()) as Upload;
		expect(second.expiresAt).toBe(first.expiresAt);
	});

	it("checks the ttl before publishing anything", async () => {
		const response = await api("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttl: "1y" }) });
		expect(response.status).toBe(400);
		expect(((await (await api("/pages")).json()) as { pages: unknown[] }).pages).toEqual([]);
	});

	it("gets its ttl from whichever way its first content arrives", async () => {
		const replaced = await startUpload({});
		const put = await api(`/pages/${replaced.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: "<h1>put</h1>" }) });
		expect(await put.json()).toMatchObject({ permanent: true, expiresAt: null });

		const patched = await startUpload({ ttl: "1d" });
		const start = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(start + 10 * 60_000);
		const patch = await api(`/pages/${patched.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ path: "index.html", content: "patched" }] }),
		});
		expect(await patch.json()).toMatchObject({ permanent: false, expiresAt: start + 10 * 60_000 + 24 * HOUR });

		// Both survive past the upload window.
		vi.spyOn(Date, "now").mockReturnValue(start + 2 * HOUR);
		expect(await (await call(replaced.url)).text()).toBe("<h1>put</h1>");
		expect(await (await call(patched.url)).text()).toBe("patched");
	});

	it("can't be faked by a page's own content", async () => {
		const page = await publish({ ttl: "1h", files: [{ path: "index.html", content: '<meta name="ephemera-upload-ttl" content="permanent">' }] });
		const created = await startUpload({ id: page.id });
		expect((await (await upload(created.uploadUrl, { "index.html": "new" })).json()) as Upload).toMatchObject({ permanent: false, expiresAt: page.expiresAt });
	});

	it("keeps an expiry the owner set before the first upload", async () => {
		const created = await startUpload({ ttl: "10m" });
		const patched = (await (await api(`/pages/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttl: "7d" }) })).json()) as Upload;
		const uploaded = (await (await upload(created.uploadUrl, { "index.html": "up" })).json()) as Upload;
		expect(uploaded.expiresAt).toBe(patched.expiresAt);
	});

	it("applies the ttl once, even after a rollback to the placeholder", async () => {
		const created = await startUpload({ ttl: "2d" });
		const first = (await (await upload(created.uploadUrl, { "index.html": "one" })).json()) as Upload;
		const rollback = await api(`/pages/${created.id}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) });
		expect(rollback.status).toBe(200);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50 * 60_000);
		const again = await startUpload({ id: created.id });
		const second = (await (await upload(again.uploadUrl, { "index.html": "two" })).json()) as Upload;
		expect(second.expiresAt).toBe(first.expiresAt);
	});

	it("leaves an existing page's expiry alone", async () => {
		const page = await publish({ ttl: "1h" });
		const created = await startUpload({ id: page.id, ttl: "permanent" });
		expect((await (await upload(created.uploadUrl, { "index.html": "new" })).json()) as Upload).toMatchObject({ expiresAt: page.expiresAt });
	});
});

import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/domain.ts";
import { mockupIndex, mockupOptions, slugify } from "../src/mockups.ts";
import { ID_PATTERN, Pages } from "../src/pages.ts";
import { screenshotOptions } from "../src/thumbnails.ts";
import { ADMIN, api, call, PAGES, publish } from "./helpers.ts";

afterEach(async () => {
	vi.mocked(screenshotOptions)
		.mockReset()
		.mockImplementation(async (_browser, urls) => urls.map(() => null));
	await reset();
});

type File = { path: string; content: string; encoding?: "utf8" | "base64" };

const TWO_OPTIONS: File[] = [
	{ path: "a/index.html", content: "<p>option a</p>" },
	{ path: "b/index.html", content: "<p>option b</p>" },
];

interface MockupView {
	id: string;
	url: string;
	kind: string;
	project: string | null;
	label: string | null;
	permanent: boolean;
	options: { name: string; path: string; verdict: string; note: string | null }[];
	[key: string]: unknown;
}

async function publishMockup(body: Record<string, unknown> = {}): Promise<MockupView> {
	const response = await api("/mockups", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ project: "Website", name: "Widget density", files: TWO_OPTIONS, ...body }),
	});
	if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
	return response.json();
}

function verdict(id: string, body: Record<string, unknown>): Promise<Response> {
	return api(`/pages/${id}/verdict`, { method: "POST", body: JSON.stringify(body) });
}

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
	return api(`/pages/${id}/files`, { method: "POST", body: JSON.stringify(body) });
}

async function options(id: string): Promise<{ name: string; verdict: string; note: string | null }[]> {
	return ((await (await api(`/pages/${id}`)).json()) as MockupView).options;
}

describe("mockup ids", () => {
	it("slugifies the project and name and appends 6 random characters", async () => {
		const set = await publishMockup({ project: "Website", name: "Widget density!" });
		expect(set.id).toMatch(/^website-widget-density-[a-z2-7]{6}$/);
		expect(set.url).toBe(`${PAGES}/${set.id}/`);
		expect(set.project).toBe("website");
		expect(set.label).toBe("Widget density!");
	});

	it("caps the slug at 40 characters, and drops accents and punctuation", () => {
		expect(slugify("  Café  --  Déjà vu  ")).toBe("cafe-deja-vu");
		const long = slugify(`spotify-remastered-${"very ".repeat(20)}long`);
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long).not.toMatch(/-$/);
	});

	it("refuses a project and name with nothing to slug", async () => {
		const response = await api("/mockups", { method: "POST", body: JSON.stringify({ project: "!!", name: "??", files: TWO_OPTIONS }) });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/letters or digits/);
	});

	it("routes both id shapes, and nothing else", async () => {
		expect(ID_PATTERN.test("abcdefghijk2")).toBe(true);
		expect(ID_PATTERN.test("website-widget-density-k3x7q2")).toBe(true);
		for (const id of ["website-k3x9q", "-website-k3x9q2", "website--x-k3x9q2", "Website-k3x9q2", "website-k3x9q8", `${"a".repeat(41)}-k3x9q2`]) {
			expect(ID_PATTERN.test(id), id).toBe(false);
		}
		const set = await publishMockup();
		expect((await call(`${PAGES}/${set.id}`)).headers.get("location")).toBe(`/${set.id}/`);
		expect(await (await call(`${set.url}a/`)).text()).toBe("<p>option a</p>");
		expect((await call(`${PAGES}/nope-k3x9q2/`)).status).toBe(404);
	});
});

describe("mockup limits", () => {
	it("counts mockup sets apart from pages", async () => {
		await publish({ ttl: "permanent" });
		const set = await publishMockup();
		expect(set.permanent).toBe(true);
		const { usage } = (await (await api("/pages")).json()) as { usage: Record<string, number> };
		expect(usage).toMatchObject({ permanentPages: 1, mockups: 1 });
		expect((await api(`/pages/${set.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "1d" }) })).status).toBe(200);
		expect((await api(`/pages/${set.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "permanent" }) })).status).toBe(200);
	});

	it("caps a mockup set at 2 MB, and counts it in the storage total", async () => {
		const big = "x".repeat(LIMITS.mockupBytes + 1);
		const response = await api("/mockups", {
			method: "POST",
			body: JSON.stringify({ project: "p", name: "n", files: [{ path: "a/index.html", content: big }] }),
		});
		expect(response.status).toBe(413);
		expect(((await response.json()) as { error: string }).error).toMatch(/2 MB/);

		await publishMockup();
		const { usage } = (await (await api("/pages")).json()) as { usage: { bytes: number } };
		expect(usage.bytes).toBe("<p>option a</p>".length * 2);
	});

	it("keeps the 2 MB cap when files are patched in", async () => {
		const set = await publishMockup();
		const response = await patch(set.id, { files: [{ path: "c/index.html", content: "x".repeat(LIMITS.mockupBytes) }] });
		expect(response.status).toBe(413);
	});
});

describe("mockup options", () => {
	it("are the top-level folders with an index.html, or main for a single page", () => {
		const names = (paths: string[]) => mockupOptions(paths).map((option) => `${option.name}${option.folder ? "/" : ""}`);
		expect(names(["compact/index.html", "a/index.html", "a/app.css", "assets/logo.png", "notes/readme.txt"])).toEqual(["a/", "compact/"]);
		expect(names(["index.html", "style.css"])).toEqual(["main"]);
		expect(names(["main/index.html"])).toEqual(["main/"]);
		expect(names(["index.html", "a/index.html"])).toEqual(["a/"]);
		expect(names(["a/b/index.html"])).toEqual([]);
	});

	it("start pending when a set is published", async () => {
		const set = await publishMockup();
		expect(set.options).toEqual([
			{ name: "a", path: "a/", verdict: "pending", note: null, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
			{ name: "b", path: "b/", verdict: "pending", note: null, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
		]);
		const single = await publishMockup({ files: [{ path: "index.html", content: "<p>one</p>" }] });
		expect(single.options.map((o) => o.name)).toEqual(["main"]);
	});

	it("need an index.html at the root or in a top-level folder", async () => {
		const response = await api("/mockups", { method: "POST", body: JSON.stringify({ project: "p", name: "n", files: [{ path: "a/b/index.html", content: "x" }] }) });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/top-level folder/);
	});

	it("follow patches: a new folder adds a pending option, removing one drops it and its verdict", async () => {
		const set = await publishMockup();
		await verdict(set.id, { option: "b", verdict: "picked", note: "nice" });

		expect((await patch(set.id, { files: [{ path: "c/index.html", content: "<p>c</p>" }, { path: "a/extra.css", content: "p{}" }] })).status).toBe(200);
		expect((await options(set.id)).map((o) => [o.name, o.verdict])).toEqual([
			["a", "pending"],
			["b", "picked"],
			["c", "pending"],
		]);

		expect((await patch(set.id, { remove: ["b/"] })).status).toBe(200);
		expect((await options(set.id)).map((o) => o.name)).toEqual(["a", "c"]);
		expect((await call(`${set.url}b/`)).status).toBe(404);
		expect((await patch(set.id, { remove: ["b/"] })).status).toBe(404);

		// Adding it back starts it from pending again.
		await patch(set.id, { files: [{ path: "b/index.html", content: "<p>b again</p>" }] });
		expect((await options(set.id)).find((o) => o.name === "b")).toMatchObject({ verdict: "pending", note: null });
	});

	it("follow updates and rollbacks", async () => {
		const set = await publishMockup();
		await verdict(set.id, { option: "a", verdict: "rejected" });
		await api(`/pages/${set.id}`, { method: "PUT", body: JSON.stringify({ files: [{ path: "a/index.html", content: "a2" }, { path: "z/index.html", content: "z" }] }) });
		expect((await options(set.id)).map((o) => [o.name, o.verdict])).toEqual([
			["a", "rejected"],
			["z", "pending"],
		]);
		await api(`/pages/${set.id}/rollback`, { method: "POST", body: JSON.stringify({ version: 1 }) });
		expect((await options(set.id)).map((o) => [o.name, o.verdict])).toEqual([
			["a", "rejected"],
			["b", "pending"],
		]);
	});
});

describe("verdicts", () => {
	it("picks, rejects and resets options, with an optional one-line note", async () => {
		const set = await publishMockup();
		const picked = await verdict(set.id, { option: "a", verdict: "picked", note: "denser\nbut fine" });
		expect(picked.status).toBe(200);
		expect(((await picked.json()) as MockupView).options[0]).toMatchObject({ name: "a", verdict: "picked", note: "denser but fine" });

		// No note keeps the note; an empty one clears it.
		await verdict(set.id, { option: "a", verdict: "rejected" });
		expect((await options(set.id))[0]).toMatchObject({ verdict: "rejected", note: "denser but fine" });
		await verdict(set.id, { option: "a", verdict: "pending", note: "" });
		expect((await options(set.id))[0]).toMatchObject({ verdict: "pending", note: null });
	});

	it("rejects unknown options and verdicts, and plain pages", async () => {
		const set = await publishMockup();
		const unknown = await verdict(set.id, { option: "q", verdict: "picked" });
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as { error: string }).error).toMatch(/"a", "b"/);
		expect((await verdict(set.id, { option: "a", verdict: "maybe" })).status).toBe(400);
		const page = await publish();
		expect((await verdict(page.id, { option: "main", verdict: "picked" })).status).toBe(400);
	});

	it("are forgotten with the set", async () => {
		const pages = new Pages(env, { defer: () => {}, now: () => Date.now() + 2 * LIMITS.goneGrace });
		const set = await publishMockup();
		await api(`/pages/${set.id}`, { method: "DELETE" });
		await pages.sweep();
		expect(await new Pages(env, { defer: () => {} }).options(set.id)).toEqual([]);
	});
});

describe("the set page", () => {
	it("shows the options side by side when the set has no index of its own", async () => {
		const set = await publishMockup();
		const response = await call(set.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("content-security-policy")).toMatch(/^sandbox/);
		const html = await response.text();
		expect(html).toContain('<iframe src="a/" title="a"');
		expect(html).toContain('<iframe src="b/" title="b"');
		expect(html).toContain("Widget density");
		expect(html).not.toContain("picked</span>");
	});

	it("badges picked options, and doesn't mark rejected ones", async () => {
		const set = await publishMockup();
		await verdict(set.id, { option: "a", verdict: "picked" });
		await verdict(set.id, { option: "b", verdict: "rejected" });
		const html = await (await call(set.url)).text();
		expect(html).toMatch(/<figure class="option picked" data-option="a"[^>]*>\s*<figcaption><a class="name" href="#option=a">a<\/a> <span class="badge">picked<\/span>/);
		expect(html).toMatch(/<figure class="option" data-option="b"[^>]*>\s*<figcaption><a class="name" href="#option=b">b<\/a><a class="open"/);
		expect(html).not.toContain("rejected");
	});

	it("shows a picked option's note, and keeps the label out of reach of the script", () => {
		const html = mockupIndex("</script><b>", [
			{ name: "a", path: "a/", verdict: "picked", note: "denser <but> fine", updatedAt: 0 },
			{ name: "b", path: "b/", verdict: "rejected", note: "too busy", updatedAt: 0 },
		]);
		expect(html).toContain('<p class="note">denser &#60;but&#62; fine</p>');
		expect(html).not.toContain("too busy");
		expect(html.match(/<\/script>/g)).toHaveLength(2);
	});

	it("escapes option names and the label", () => {
		const html = mockupIndex("<b>x</b>", [{ name: 'a"<', path: "a%22%3C/", verdict: "pending", note: null, updatedAt: 0 }]);
		expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
		expect(html).toContain('src="a%22%3C/"');
	});

	it("keeps showing current verdicts when the set's missing index is cached, and its own index once one is added", async () => {
		const set = await publishMockup();
		expect(await (await call(set.url)).text()).not.toContain("picked</span>");
		await verdict(set.id, { option: "a", verdict: "picked" });
		expect(await (await call(set.url)).text()).toContain("picked</span>");
		await patch(set.id, { files: [{ path: "index.html", content: "<p>custom</p>" }] });
		expect(await (await call(set.url)).text()).toBe("<p>custom</p>");
	});

	it("serves the set's own root index.html instead, if it has one", async () => {
		const set = await publishMockup({ files: [...TWO_OPTIONS, { path: "index.html", content: "<p>custom</p>" }] });
		expect(await (await call(set.url)).text()).toBe("<p>custom</p>");
		expect(set.options.map((o) => o.name)).toEqual(["a", "b"]);
	});

	it("works for private sets, through a pass", async () => {
		const set = await publishMockup({ visibility: "private" });
		expect((await call(set.url)).status).toBe(401);
		const link = ((await (await api(`/pages/${set.id}/share`, { method: "POST", body: JSON.stringify({ ttl: "1h" }) })).json()) as { url: string }).url;
		expect(await (await call(link)).text()).toContain('<iframe src="a/"');
		expect(await (await call(`${link}a/`)).text()).toBe("<p>option a</p>");
	});
});

describe("the dashboard's Mockups tab", () => {
	function admin(path = "/", init: RequestInit = {}): Promise<Response> {
		return call(`${ADMIN}${path}`, init, { accessAud: "test-aud" });
	}

	it("groups sets by project, newest first, with a thumbnail and verdict buttons per option", async () => {
		const older = await publishMockup({ project: "website", name: "Older" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const newer = await publishMockup({ project: "website", name: "Newer" });
		await publishMockup({ project: "app", name: "Grid" });
		await verdict(newer.id, { option: "a", verdict: "picked" });

		const html = await (await admin("/mockups")).text();
		expect(html).toContain('aria-current="page">Mockups');
		expect(html.indexOf("<h2>app</h2>")).toBeLessThan(html.indexOf("<h2>website</h2>"));
		expect(html.indexOf(newer.id)).toBeLessThan(html.indexOf(older.id));
		expect(html).toContain(`<img src="/thumbnails/${newer.id}/a.png?v=1"`);
		expect(html).toContain('<figure class="option picked">');
		expect(html).toContain(`action="/pages/${newer.id}/verdict"`);
		expect(html).toContain('id="verdict"');
		expect(html).toContain('data-verdicts="picked pending"');

		// Mockups stay off the Pages tab.
		await publish({ label: "a plain page" });
		const pagesTab = await (await admin("/")).text();
		expect(pagesTab).toContain("a plain page");
		expect(pagesTab).not.toContain(newer.id);
		expect(pagesTab).toContain("3 mockup sets");
	});

	it("records verdicts and comes back to the tab", async () => {
		const set = await publishMockup();
		const csrf = /name="csrf" value="([^"]+)"/.exec(await (await admin("/mockups")).text())![1]!;
		const response = await admin(`/pages/${set.id}/verdict`, {
			method: "POST",
			headers: { origin: ADMIN, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ csrf, back: "/mockups", option: "b", verdict: "rejected", note: "too busy" }),
		});
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/mockups");
		expect((await options(set.id))[1]).toMatchObject({ verdict: "rejected", note: "too busy" });
	});

	it("shoots every option of a set with one browser launch, and keeps the shots", async () => {
		const shots = [new Uint8Array([1]), new Uint8Array([2])];
		vi.mocked(screenshotOptions).mockResolvedValue(shots);
		const set = await publishMockup();

		const [a, b] = await Promise.all([admin(`/thumbnails/${set.id}/a.png`), admin(`/thumbnails/${set.id}/b.png`)]);
		expect(new Uint8Array(await a!.arrayBuffer())).toEqual(shots[0]);
		expect(new Uint8Array(await b!.arrayBuffer())).toEqual(shots[1]);
		expect(screenshotOptions).toHaveBeenCalledTimes(1);
		expect(vi.mocked(screenshotOptions).mock.calls[0]![1]).toEqual([`${set.url}a/`, `${set.url}b/`]);

		await admin(`/thumbnails/${set.id}/a.png`);
		expect(screenshotOptions).toHaveBeenCalledTimes(1);
		expect((await admin(`/thumbnails/${set.id}/zz.png`)).status).toBe(404);
	});

	it("shoots a single-page set at its root", async () => {
		vi.mocked(screenshotOptions).mockResolvedValue([new Uint8Array([1])]);
		const set = await publishMockup({ files: [{ path: "index.html", content: "<p>one</p>" }] });
		await admin(`/thumbnails/${set.id}/main.png`);
		expect(vi.mocked(screenshotOptions).mock.calls[0]![1]).toEqual([set.url]);
	});

	it("links, shoots and shows an option in its folder even when it's a lone main/", async () => {
		vi.mocked(screenshotOptions).mockResolvedValue([new Uint8Array([1])]);
		const set = await publishMockup({ files: [{ path: "main/index.html", content: "<p>one</p>" }] });
		expect(set.options).toEqual([expect.objectContaining({ name: "main", path: "main/" })]);
		const html = await (await admin("/mockups")).text();
		expect(html).toContain(`<a class="shot" href="${set.url}main/"`);
		await admin(`/thumbnails/${set.id}/main.png`);
		expect(vi.mocked(screenshotOptions).mock.calls[0]![1]).toEqual([`${set.url}main/`]);
		expect(await (await call(set.url)).text()).toContain('data-src="main/"');
	});

	it("links a single-page set's main option to the set's root", async () => {
		const set = await publishMockup({ files: [{ path: "index.html", content: "<p>one</p>" }] });
		expect(set.options).toEqual([expect.objectContaining({ name: "main", path: "" })]);
		expect(await (await admin("/mockups")).text()).toContain(`<a class="shot" href="${set.url}"`);
	});

	it("encodes an option's folder into its path", async () => {
		const set = await publishMockup({ files: [{ path: "a b#1/index.html", content: "<p>one</p>" }, { path: "c/index.html", content: "<p>two</p>" }] });
		expect(set.options.map((option) => option.path)).toEqual(["a%20b%231/", "c/"]);
		expect(await (await call(set.url)).text()).toContain('<iframe src="a%20b%231/"');
		const html = await (await admin("/mockups")).text();
		expect(html).toContain(`<a class="shot" href="${set.url}a%20b%231/"`);
	});

	it("moves an option between the root and its folder when an update does", async () => {
		const set = await publishMockup({ files: [{ path: "index.html", content: "<p>one</p>" }] });
		await api(`/pages/${set.id}`, { method: "PUT", body: JSON.stringify({ files: [{ path: "main/index.html", content: "<p>one</p>" }] }) });
		expect(await options(set.id)).toEqual([expect.objectContaining({ name: "main", path: "main/" })]);
	});
});

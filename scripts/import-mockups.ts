/**
 * One-off import of the mockups scattered across Jacob's repos into the
 * mockup gallery, as mockup sets. The repos are only read.
 *
 *   node scripts/import-mockups.ts --dry-run   # build the bundles into /tmp/ephemera-import and print them
 *   EPHEMERA_TOKEN=… node scripts/import-mockups.ts
 *
 * Each option starts from one HTML file. The files it uses (stylesheets,
 * scripts, images, pages it links to) are found by following its references,
 * so review screenshots lying around the folders stay behind. Every local
 * reference is rewritten to a relative path inside the set, including ones
 * in CSS and JS, which ephemera's link rewriting can't reach. Sets already
 * in the gallery (same project and name) are skipped, so it can be re-run.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";

const HOME = homedir();
const API = "https://p.rcn.sh/api";
const OUT = "/tmp/ephemera-import";

interface Source {
	/** Folder the HTML files live in. */
	dir: string;
	/** Root-relative URL prefixes the pages were served with, and the folders behind them. */
	roots?: Record<string, string>;
}

interface Option {
	name: string;
	/** The option's page, relative to the source folder. */
	file?: string;
	/** More files to include, relative to the source folder (for references built in JavaScript). */
	extra?: string[];
	/** Instead of a file: a page made from these files' text, for options that never had a mockup page. */
	source?: string[];
	verdict?: "rejected";
	note?: string;
}

interface SetSpec {
	project: string;
	name: string;
	source: Source;
	/** One option made from a single page becomes the set's root index.html, option "main". */
	options: Option[];
}

const TERMINUS: Source = {
	dir: `${HOME}/dev/terminus/dev/mockups`,
	roots: {
		"/assets/": `${HOME}/dev/terminus/apps/web/public/assets`,
		"/account/": `${HOME}/dev/terminus/apps/web/public/account`,
		"/mockups/": `${HOME}/dev/terminus/dev/mockups`,
	},
};
const BUS_TIMES: Source = { dir: `${TERMINUS.dir}/bus-times`, roots: TERMINUS.roots };
const CS_SKINS: Source = { dir: `${HOME}/dev/cs-skins/mockups` };
const SPOTIFY: Source = { dir: `${HOME}/dev/spotify-remastered/docs/design/mockups` };
const WIDGETS: Source = { dir: `${HOME}/dev/widget-mockups` };

const page = (name: string, file: string, more: Partial<Option> = {}): Option => ({ name, file, ...more });

const SETS: SetSpec[] = [
	{ project: "terminus", name: "Landing page", source: TERMINUS, options: [page("a-sky", "landing-a-sky.html"), page("b-livery", "landing-b-livery.html"), page("c-trip", "landing-c-trip.html")] },
	{ project: "terminus", name: "Status page", source: TERMINUS, options: [page("a-horizon", "status-a-horizon.html"), page("b-board", "status-b-board.html")] },
	{
		project: "terminus",
		name: "Privacy page",
		source: TERMINUS,
		options: [page("a-rows", "privacy-a-rows.html"), page("a2-full-below", "privacy-a2-full-below.html"), page("a3-summary", "privacy-a3-summary.html"), page("b-route", "privacy-b-route.html")],
	},
	{ project: "terminus", name: "Pair a device", source: TERMINUS, options: [page("a-livery", "pair-a-livery.html"), page("b-sky", "pair-b-sky.html")] },
	{ project: "terminus", name: "API docs bar", source: TERMINUS, options: [page("main", "docs-a-band.html")] },
	{ project: "terminus", name: "Not found page", source: TERMINUS, options: [page("main", "notfound-a.html")] },
	{ project: "terminus", name: "Favourites", source: TERMINUS, options: [page("main", "favourites.html")] },
	{ project: "terminus", name: "Feedback", source: TERMINUS, options: [page("signed-in", "feedback.html"), page("anon", "feedback-anon.html"), page("d", "feedback-d.html")] },
	{
		project: "terminus",
		name: "Settings band",
		source: TERMINUS,
		options: [page("main", "settings-band.html", { extra: readdirSync(`${TERMINUS.dir}/settings-band`).map((file) => `settings-band/${file}`) })],
	},
	{ project: "terminus", name: "Map sheets", source: TERMINUS, options: [page("main", "sheets.html")] },
	{ project: "terminus", name: "Stop sheet", source: TERMINUS, options: [page("main", "stop-sheet.html")] },
	{ project: "terminus", name: "Tile", source: TERMINUS, options: [page("main", "tile.html")] },
	{ project: "terminus", name: "Widgets", source: TERMINUS, options: [page("main", "widgets.html")] },
	{
		project: "terminus",
		name: "Buses tab options",
		source: BUS_TIMES,
		options: ["opt1-nearby", "opt2-lines", "opt3-board", "opt3-board-dark", "opt4-pinned", "opt5-timeline", "opt6-mapsheet", "opt7-planner"].map((name) => page(name, `${name}.html`)),
	},
	{
		project: "terminus",
		name: "Buses tab recommendation",
		source: BUS_TIMES,
		options: ["rec1-home", "rec1-home-dark", "rec2-service", "rec3-search", "rec3-trip", "rec4-map", "rec5-widget"].map((name) => page(name, `${name}.html`)),
	},
	{
		project: "terminus",
		name: "Widget ideas",
		source: WIDGETS,
		options: [
			page("countdown", "countdown.html"),
			page("countdown-best", "countdown-best.html"),
			page("both-sides", "both-sides.html"),
			{ name: "via", source: ["discarded/via.ts", "discarded/via-wip.patch"], verdict: "rejected", note: "discarded" },
		],
	},
	{
		project: "cs-skins",
		name: "Loadout",
		source: CS_SKINS,
		options: [page("a-playlist", "a-playlist.html"), page("b-command", "b-command.html"), page("c-market", "c-market.html"), page("d-moodboard", "d-moodboard.html")],
	},
	{ project: "spotify-remastered", name: "App screens", source: SPOTIFY, options: [page("main", "mockups.html")] },
];

/** References to other files: [pattern, group holding the URL]. */
const REFERENCES: Record<string, RegExp[]> = {
	html: [/\b(?:src|href|poster|data)\s*=\s*"([^"]+)"/g, /\b(?:src|href|poster|data)\s*=\s*'([^']+)'/g, /url\(\s*['"]?([^'")\s]+)/g, /@import\s+['"]([^'"]+)/g, /\bfrom\s*['"]([^'"]+)/g, /import\(\s*['"]([^'"]+)/g],
	css: [/url\(\s*['"]?([^'")\s]+)/g, /@import\s+['"]([^'"]+)/g],
	js: [/\bfrom\s*['"]([^'"]+)/g, /import\(\s*['"]([^'"]+)/g, /new URL\(\s*['"]([^'"]+)/g, /fetch\(\s*['"]([^'"]+)/g],
};

function kindOf(path: string): keyof typeof REFERENCES | null {
	if (/\.html?$/i.test(path)) return "html";
	if (/\.css$/i.test(path)) return "css";
	if (/\.m?js$/i.test(path)) return "js";
	return null;
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

/** Builds one set's files: bundle path → contents. */
function bundle(set: SetSpec): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	const roots = Object.entries(set.source.roots ?? {});
	const single = set.options.length === 1 && set.options[0]!.name === "main";

	for (const option of set.options) {
		const folder = single ? "" : `${option.name}/`;
		if (option.source) {
			const sections = option.source.map((file) => `<h2>${escape(file)}</h2>\n<pre>${escape(readFileSync(join(set.source.dir, file), "utf8"))}</pre>`).join("\n");
			const html = `<!doctype html>\n<meta charset="utf-8">\n<title>${escape(option.name)}</title>\n<style>body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; } pre { font: 12px/1.45 ui-monospace, Menlo, monospace; background: #f4f4f4; padding: 1rem; overflow: auto; }</style>\n<p>No mockup page: what was kept of the idea.</p>\n${sections}\n`;
			files.set(`${folder}index.html`, new TextEncoder().encode(html));
			continue;
		}
		const entry = resolve(set.source.dir, option.file!);
		const entryDir = dirname(entry);
		/** Where a source file goes in the bundle. */
		const place = (file: string): string => {
			if (file === entry) return `${folder}index.html`;
			if (!relative(entryDir, file).startsWith("..")) return `${folder}${relative(entryDir, file)}`;
			for (const [prefix, dir] of roots) {
				if (!relative(dir, file).startsWith("..")) return `${prefix.slice(1)}${relative(dir, file)}`;
			}
			throw new Error(`${file} is outside ${entryDir} and every root`);
		};
		const queue = [entry, ...(option.extra ?? []).map((file) => resolve(set.source.dir, file))];
		const seen = new Set<string>();
		while (queue.length) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const at = place(file);
			const kind = kindOf(file);
			if (!kind) {
				files.set(at, readFileSync(file));
				continue;
			}
			let text = readFileSync(file, "utf8");
			for (const pattern of REFERENCES[kind]!) {
				text = text.replace(pattern, (match, url: string) => {
					if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#|\$\{/i.test(url)) return match;
					const path = decodeURI(url.replace(/[?#].*$/, ""));
					if (!path) return match;
					let target: string | undefined;
					if (path.startsWith("/")) {
						const root = roots.find(([prefix]) => path.startsWith(prefix));
						if (root) target = join(root[1], path.slice(root[0].length));
					} else {
						target = resolve(dirname(file), path);
					}
					// The source folder's own gallery page isn't part of any option.
					if (!target || !isFile(target) || (target === join(set.source.dir, "index.html") && target !== entry)) return match;
					queue.push(target);
					const rewritten = posix.relative(posix.dirname(`/${at}`), `/${place(target)}`) + url.slice(url.replace(/[?#].*$/, "").length);
					return match.replace(url, rewritten || "./");
				});
			}
			files.set(at, new TextEncoder().encode(text));
		}
	}
	return files;
}

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${process.env.EPHEMERA_TOKEN}`, "content-type": "application/json", ...init.headers },
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${body.error}`);
	return body;
}

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && !process.env.EPHEMERA_TOKEN) throw new Error("Set EPHEMERA_TOKEN, or pass --dry-run");

const existing = dryRun ? [] : ((await call("/pages")).pages as { kind: string; project: string; label: string }[]).filter((p) => p.kind === "mockup");
rmSync(OUT, { recursive: true, force: true });

for (const set of SETS) {
	const files = bundle(set);
	const size = [...files.values()].reduce((total, body) => total + body.byteLength, 0);
	const line = `${set.project} / ${set.name}: ${set.options.length} option(s), ${files.size} files, ${(size / 1024).toFixed(0)} KB`;
	if (dryRun) {
		for (const [path, body] of files) {
			mkdirSync(dirname(join(OUT, set.project, set.name, path)), { recursive: true });
			writeFileSync(join(OUT, set.project, set.name, path), body);
		}
		console.log(line);
		continue;
	}
	const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	if (existing.some((p) => p.project === slug(set.project) && p.label === set.name)) {
		console.log(`${line}: already imported, skipped`);
		continue;
	}
	const published = await call("/mockups", {
		method: "POST",
		body: JSON.stringify({
			project: set.project,
			name: set.name,
			files: [...files].map(([path, body]) => ({ path, content: Buffer.from(body).toString("base64"), encoding: "base64" })),
		}),
	});
	for (const option of set.options.filter((o) => o.verdict)) {
		await call(`/pages/${published.id}/verdict`, { method: "POST", body: JSON.stringify({ option: option.name, verdict: option.verdict, note: option.note }) });
	}
	console.log(`${line}: ${published.url}${published.warnings?.length ? `\n  ${published.warnings.join("\n  ")}` : ""}`);
}

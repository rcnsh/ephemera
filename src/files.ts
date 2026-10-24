import { unzipSync } from "fflate";
import { bytesText, LIMITS, PageError } from "./domain.ts";
import { markdownPage } from "./markdown.ts";

export interface PageFile {
	path: string;
	body: Uint8Array;
}

export interface InlineFile {
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
}

/**
 * Turns a user-supplied path into the canonical key used in storage, or throws.
 * Canonical paths are relative, `/`-separated and never escape the page.
 */
export function normalizePath(raw: string): string {
	let path = raw.trim();
	while (path.startsWith("./")) path = path.slice(2);
	path = path.replace(/^\/+/, "");
	if (!path || path.length > LIMITS.pathLength) throw new PageError(400, `Invalid file path "${raw}"`);
	if (/[\\\u0000-\u001f\u007f]/.test(path)) throw new PageError(400, `Invalid characters in file path "${raw}"`);
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new PageError(400, `Invalid file path "${raw}"`);
		}
	}
	return path;
}

export function decodeInlineFiles(files: InlineFile[]): PageFile[] {
	const encoder = new TextEncoder();
	return files.map((file) => {
		const path = normalizePath(file.path);
		if (file.encoding === "base64") {
			try {
				return { path, body: Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)) };
			} catch {
				throw new PageError(400, `File "${path}" is not valid base64`);
			}
		}
		return { path, body: encoder.encode(file.content) };
	});
}

/** A page's content as agents can give it: files, or one of the single-page shortcuts. */
export interface BundleInput {
	files?: InlineFile[] | null;
	html?: string | null;
	markdown?: string | null;
}

/** Turns exactly one of `files`, `html` or `markdown` into the page's files. `title` names a Markdown page. */
export function bundleFrom(input: BundleInput, title?: string | null): PageFile[] {
	const given = [input.files, input.html, input.markdown].filter((value) => value !== undefined && value !== null);
	if (given.length !== 1) throw new PageError(400, "Give exactly one of files, html or markdown");
	if (typeof input.html === "string") return decodeInlineFiles([{ path: "index.html", content: input.html }]);
	if (typeof input.markdown === "string") return decodeInlineFiles([{ path: "index.html", content: markdownPage(input.markdown, title) }]);
	if (!Array.isArray(input.files)) throw new PageError(400, "files must be an array of { path, content, encoding }");
	return decodeInlineFiles(input.files);
}

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/;

/**
 * Unpacks a zip bundle. Sizes are checked from the zip headers before anything
 * is inflated, so a zip bomb is rejected without being expanded. When every
 * file sits under one top-level folder and there's no root index.html (what
 * `zip -r site.zip site/` produces), that folder is stripped.
 */
export function unzipFiles(zip: Uint8Array): PageFile[] {
	let declaredBytes = 0;
	let declaredFiles = 0;
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(zip, {
			filter(file) {
				if (file.name.endsWith("/") || JUNK.test(file.name)) return false;
				declaredBytes += file.originalSize;
				declaredFiles += 1;
				if (declaredBytes > LIMITS.pageBytes) throw new PageError(413, `Zip contents exceed the ${bytesText(LIMITS.pageBytes)} page limit`);
				if (declaredFiles > LIMITS.pageFiles) throw new PageError(413, `Zip has more than ${LIMITS.pageFiles} files`);
				return true;
			},
		});
	} catch (error) {
		if (error instanceof PageError) throw error;
		throw new PageError(400, "Upload is not a valid zip file");
	}

	let names = Object.keys(entries);
	const roots = new Set(names.map((name) => name.split("/")[0]));
	if (!names.includes("index.html") && roots.size === 1 && names.every((name) => name.includes("/"))) {
		const prefix = `${[...roots][0]}/`;
		entries = Object.fromEntries(names.map((name) => [name.slice(prefix.length), entries[name]!]));
		names = Object.keys(entries);
	}
	return names.map((name) => ({ path: normalizePath(name), body: entries[name]! }));
}

/**
 * Checks a bundle against the per-page limits. Returns it with every path in
 * canonical form (normalizing twice changes nothing), plus its total size.
 */
export function validateBundle(input: PageFile[]): { files: PageFile[]; size: number } {
	const files = input.map((file) => ({ path: normalizePath(file.path), body: file.body }));
	const size = checkBundle(
		files.map((file) => file.path),
		files.reduce((total, file) => total + file.body.byteLength, 0),
	);
	return { files, size };
}

/** The per-page limits, for a bundle given as its canonical paths and total size. */
export function checkBundle(paths: string[], size: number): number {
	if (paths.length === 0) throw new PageError(400, "A page needs at least one file");
	if (paths.length > LIMITS.pageFiles) throw new PageError(413, `A page can have at most ${LIMITS.pageFiles} files`);
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) throw new PageError(400, `Duplicate file path "${path}"`);
		seen.add(path);
	}
	if (!seen.has("index.html")) throw new PageError(400, "A page needs an index.html at its root");
	if (size > LIMITS.pageBytes) throw new PageError(413, `A page can be at most ${bytesText(LIMITS.pageBytes)}`);
	return size;
}

const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	webm: "video/webm",
	pdf: "application/pdf",
	wasm: "application/wasm",
};

export function contentType(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return TYPES[ext] ?? "application/octet-stream";
}

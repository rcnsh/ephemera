import { inflateSync } from "fflate";
import { bytesText, LIMITS, PageError } from "./domain.ts";
import { markdownPage } from "./markdown.ts";
import { mockupOptions } from "./mockups.ts";

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

/** Decodes inline files as callers send them, checking their shape: an array of `{ path, content, encoding }`. */
export function decodeFiles(files: unknown): PageFile[] {
	if (!Array.isArray(files)) throw new PageError(400, "files must be an array of { path, content, encoding }");
	const encoder = new TextEncoder();
	return files.map((file: Partial<InlineFile> | null) => {
		if (typeof file?.path !== "string" || typeof file.content !== "string") throw new PageError(400, "Every file needs a path and a content, both strings");
		const path = normalizePath(file.path);
		if (file.encoding === "base64") {
			try {
				return { path, body: fromBase64(file.content) };
			} catch {
				throw new PageError(400, `File "${path}" is not valid base64`);
			}
		}
		return { path, body: encoder.encode(file.content) };
	});
}

/** Base64 is decoded this many characters at a time (a multiple of 4). */
const BASE64_CHUNK = 1 << 16;

/**
 * The bytes a base64 string holds, as `atob` reads it (whitespace ignored,
 * padding optional), or throws. Decoded a slice at a time straight into the
 * result, so a large file never also exists as one binary string.
 */
export function fromBase64(text: string): Uint8Array {
	const base64 = /[^A-Za-z0-9+/=]/.test(text) ? text.replace(/[\t\n\f\r ]+/g, "") : text;
	const bytes = new Uint8Array(Math.floor(base64.length / 4) * 3 + 3);
	let length = 0;
	for (let start = 0; start < base64.length; start += BASE64_CHUNK) {
		const binary = atob(base64.slice(start, start + BASE64_CHUNK));
		for (let i = 0; i < binary.length; i++) bytes[length++] = binary.charCodeAt(i);
	}
	return bytes.subarray(0, length);
}

/**
 * A page's content as callers send it, unchecked: exactly one of inline
 * `files`, a single `html` document, a `markdown` document, or a `zip`.
 */
export interface Content {
	files?: unknown;
	html?: unknown;
	markdown?: unknown;
	zip?: Uint8Array;
}

function given(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/** Whether content was given as inline files or a zip, the only ways a mockup set's options can come. */
export function hasFiles(content: Content): boolean {
	return given(content.files) || given(content.zip);
}

/** Turns content into the page's files, or throws. `title` names a Markdown page. */
export function decodeContent(content: Content, title?: string | null): PageFile[] {
	if ([content.files, content.html, content.markdown, content.zip].filter(given).length !== 1) throw new PageError(400, "Give exactly one of files, html or markdown (or a zip)");
	if (content.zip) return unzipFiles(content.zip);
	if (given(content.html)) {
		if (typeof content.html !== "string") throw new PageError(400, "html must be a string");
		return [{ path: "index.html", body: new TextEncoder().encode(content.html) }];
	}
	if (given(content.markdown)) {
		if (typeof content.markdown !== "string") throw new PageError(400, "markdown must be a string");
		return [{ path: "index.html", body: new TextEncoder().encode(markdownPage(content.markdown, title)) }];
	}
	return decodeFiles(content.files);
}


const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/;

/** One entry of a zip's central directory: enough to size it and find its data without unpacking anything. */
interface ZipEntry {
	name: string;
	flags: number;
	method: number;
	compressedSize: number;
	size: number;
	headerOffset: number;
}

class InvalidZip extends Error {}

function u16(bytes: Uint8Array, at: number): number {
	return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
	return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

function u64(bytes: Uint8Array, at: number): number {
	return u32(bytes, at) + u32(bytes, at + 4) * 2 ** 32;
}

/** Reads a zip's central directory (zip64 included), where every entry's name and sizes are, whatever its local headers say. */
function zipEntries(zip: Uint8Array): ZipEntry[] {
	// The end record is 22 bytes, followed by a comment of up to 65535.
	const stop = Math.max(0, zip.length - 22 - 0xffff);
	let end = zip.length - 22;
	while (end >= stop && u32(zip, end) !== 0x06054b50) end--;
	if (end < stop) throw new InvalidZip();
	let count = u16(zip, end + 10);
	let at = u32(zip, end + 16);
	if (count === 0xffff || at === 0xffffffff) {
		const locator = end - 20;
		if (locator < 0 || u32(zip, locator) !== 0x07064b50) throw new InvalidZip();
		const record = u64(zip, locator + 8);
		if (record + 56 > zip.length || u32(zip, record) !== 0x06064b50) throw new InvalidZip();
		count = u64(zip, record + 32);
		at = u64(zip, record + 48);
	}
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw new InvalidZip();
		const flags = u16(zip, at + 8);
		let compressedSize = u32(zip, at + 20);
		let size = u32(zip, at + 24);
		let headerOffset = u32(zip, at + 42);
		const nameEnd = at + 46 + u16(zip, at + 28);
		const extraEnd = nameEnd + u16(zip, at + 30);
		const nameBytes = zip.subarray(at + 46, nameEnd);
		// Names are UTF-8 when flagged, and read as Latin-1 otherwise (as fflate does).
		const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : String.fromCharCode(...nameBytes);
		for (let field = nameEnd; field + 4 <= extraEnd; field += 4 + u16(zip, field + 2)) {
			if (u16(zip, field) !== 1) continue;
			// Zip64 sizes and offset, present only for the fields that overflowed.
			let value = field + 4;
			if (size === 0xffffffff) (size = u64(zip, value)), (value += 8);
			if (compressedSize === 0xffffffff) (compressedSize = u64(zip, value)), (value += 8);
			if (headerOffset === 0xffffffff) headerOffset = u64(zip, value);
		}
		entries.push({ name, flags, method: u16(zip, at + 10), compressedSize, size, headerOffset });
		at = extraEnd + u16(zip, at + 32);
	}
	return entries;
}

/**
 * An entry's contents. A stored entry is a view into the zip rather than a
 * copy; a deflated one is inflated into a buffer of its declared size, which
 * a lying header can only truncate, never overflow.
 */
function entryData(zip: Uint8Array, entry: ZipEntry): Uint8Array {
	const at = entry.headerOffset;
	if (entry.flags & 1 || at + 30 > zip.length || u32(zip, at) !== 0x04034b50) throw new InvalidZip();
	const start = at + 30 + u16(zip, at + 26) + u16(zip, at + 28);
	if (start + entry.compressedSize > zip.length) throw new InvalidZip();
	const data = zip.subarray(start, start + entry.compressedSize);
	if (entry.method === 0 && entry.compressedSize === entry.size) return data;
	if (entry.method !== 8) throw new InvalidZip();
	const body = inflateSync(data, { out: new Uint8Array(entry.size) });
	if (body.byteLength !== entry.size) throw new InvalidZip();
	return body;
}

/**
 * Unpacks a zip bundle. Sizes are checked from the zip headers before anything
 * is inflated, so a zip bomb is rejected without being expanded; then entries
 * are unpacked one at a time, and stored ones aren't copied at all. When every
 * file sits under one top-level folder and there's no root index.html (what
 * `zip -r site.zip site/` produces), that folder is stripped.
 */
export function unzipFiles(zip: Uint8Array): PageFile[] {
	let declaredBytes = 0;
	let declaredFiles = 0;
	let entries = new Map<string, Uint8Array>();
	try {
		const wanted = zipEntries(zip).filter((entry) => {
			if (entry.name.endsWith("/") || JUNK.test(entry.name)) return false;
			declaredBytes += entry.size;
			declaredFiles += 1;
			if (declaredBytes > LIMITS.pageBytes) throw new PageError(413, `Zip contents exceed the ${bytesText(LIMITS.pageBytes)} page limit`);
			if (declaredFiles > LIMITS.pageFiles) throw new PageError(413, `Zip has more than ${LIMITS.pageFiles} files`);
			return true;
		});
		for (const entry of wanted) entries.set(entry.name, entryData(zip, entry));
	} catch (error) {
		if (error instanceof PageError) throw error;
		throw new PageError(400, "Upload is not a valid zip file");
	}

	let names = [...entries.keys()];
	const roots = new Set(names.map((name) => name.split("/")[0]));
	if (!names.includes("index.html") && roots.size === 1 && names.every((name) => name.includes("/"))) {
		const prefix = `${[...roots][0]}/`;
		entries = new Map(names.map((name) => [name.slice(prefix.length), entries.get(name)!]));
		names = [...entries.keys()];
	}
	return names.map((name) => ({ path: normalizePath(name), body: entries.get(name)! }));
}

/** Plain pages, or mockup sets (see mockups.ts). */
export type PageKind = "page" | "mockup";

/**
 * Checks a bundle against the per-page limits. Returns it with every path in
 * canonical form (normalizing twice changes nothing), plus its total size.
 */
export function validateBundle(input: PageFile[], kind: PageKind = "page"): { files: PageFile[]; size: number } {
	const files = input.map((file) => ({ path: normalizePath(file.path), body: file.body }));
	const size = checkBundle(
		files.map((file) => file.path),
		files.reduce((total, file) => total + file.body.byteLength, 0),
		kind,
	);
	return { files, size };
}

/**
 * The per-page limits, for a bundle given as its canonical paths and total
 * size. A mockup set needs an index.html at its root or in a top-level folder.
 */
export function checkBundle(paths: string[], size: number, kind: PageKind = "page"): number {
	if (paths.length === 0) throw new PageError(400, "A page needs at least one file");
	if (paths.length > LIMITS.pageFiles) throw new PageError(413, `A page can have at most ${LIMITS.pageFiles} files`);
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) throw new PageError(400, `Duplicate file path "${path}"`);
		seen.add(path);
	}
	if (kind === "mockup") {
		if (!mockupOptions(paths).length) throw new PageError(400, "A mockup set needs an index.html at its root or in each option's top-level folder (a/index.html, b/index.html, ...)");
		if (size > LIMITS.mockupBytes) throw new PageError(413, `A mockup set can be at most ${bytesText(LIMITS.mockupBytes)}`);
		return size;
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

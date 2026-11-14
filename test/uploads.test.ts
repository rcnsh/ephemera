import { reset } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, PageError } from "../src/domain.ts";
import { fromBase64, unzipFiles } from "../src/files.ts";
import { api, call, PAGES } from "./helpers.ts";

afterEach(() => reset());

function bytes(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function text(body: Uint8Array): string {
	return new TextDecoder().decode(body);
}

function status(work: () => unknown): number {
	try {
		work();
	} catch (error) {
		if (error instanceof PageError) return error.status;
		throw error;
	}
	throw new Error("expected a PageError");
}

/** `cd tmp && zip -qr - site`: Info-ZIP, a stored index and noise, a deflated css, and directory entries. */
const INFO_ZIP =
	"UEsDBAoAAAAAAPoBb10AAAAAAAAAAAAAAAAFABwAc2l0ZS9VVAkAAzeJ+Go3ifhqdXgLAAEE9QEAAAQUAAAAUEsDBBQACAAIAPoBb10AAAAAAAAAABEAAAAPABwAc2l0ZS9pbmRleC5odG1sVVQJAAM3ifhqN4n4anV4CwABBPUBAAAEFAAAALPJMLQrLilKTcxNTbHRB3IAUEsHCISh0RwRAAAAEQAAAFBLAwQKAAAAAAD6AW9dAAAAAAAAAAAAAAAACQAcAHNpdGUvY3NzL1VUCQADN4n4ajeJ+Gp1eAsAAQT1AQAABBQAAABQSwMEFAAIAAgA+gFvXQAAAAAAAAAAJAAAAA4AHABzaXRlL2Nzcy9hLmNzc1VUCQADN4n4ajeJ+Gp1eAsAAQT1AQAABBQAAAArqE7Oz8kvsipKTaktwMEGAFBLBwjhL3YGEQAAACQAAABQSwMEFAAIAAgA+gFvXQAAAAAAAAAAQAAAAA4AHABzaXRlL25vaXNlLmJpblVUCQADN4n4ajeJ+Gp1eAsAAQT1AQAABBQAAAABQAC//0s9LPt9/Dg0BNWW7V4X7fRs27AvuBBUTUWcYPnuQhMu0+vJp0j3bN9a4aJcZyce3zlFw11yO9jigJZ53f3DdBdQSwcIx2tYkEUAAABAAAAAUEsBAh4DCgAAAAAA+gFvXQAAAAAAAAAAAAAAAAUAGAAAAAAAAAAQAO1BAAAAAHNpdGUvVVQFAAM3ifhqdXgLAAEE9QEAAAQUAAAAUEsBAh4DFAAIAAgA+gFvXYSh0RwRAAAAEQAAAA8AGAAAAAAAAQAAAKSBPwAAAHNpdGUvaW5kZXguaHRtbFVUBQADN4n4anV4CwABBPUBAAAEFAAAAFBLAQIeAwoAAAAAAPoBb10AAAAAAAAAAAAAAAAJABgAAAAAAAAAEADtQakAAABzaXRlL2Nzcy9VVAUAAzeJ+Gp1eAsAAQT1AQAABBQAAABQSwECHgMUAAgACAD6AW9d4S92BhEAAAAkAAAADgAYAAAAAAABAAAApIHsAAAAc2l0ZS9jc3MvYS5jc3NVVAUAAzeJ+Gp1eAsAAQT1AQAABBQAAABQSwECHgMUAAgACAD6AW9dx2tYkEUAAABAAAAADgAYAAAAAAAAAAAApIFVAQAAc2l0ZS9ub2lzZS5iaW5VVAUAAzeJ+Gp1eAsAAQT1AQAABBQAAABQSwUGAAAAAAUABQCXAQAA8gEAAAAA";

/** Python's zipfile writing to a pipe: sizes only in data descriptors after each entry, so only the central directory has them. */
const STREAMED_ZIP =
	"UEsDBC0ACAAAAAAAIQAAAAAA//////////8PABQAc2l0ZS9pbmRleC5odG1sAQAQAAAAAAAAAAAAAAAAAAAAAAA8aDE+c3RyZWFtZWQ8L2gxPlBLBwiEodEcEQAAAAAAAAARAAAAAAAAAFBLAwQtAAgACAAAACEAAAAAAP//////////CgAUAHNpdGUvYS5jc3MBABAAAAAAAAAAAAAAAAAAAAAAACuoTs7PyS+yKkpNqS0YAWwAUEsHCJw6NYURAAAAAAAAAPAAAAAAAAAAUEsBAi0DLQAIAAAAAAAhAISh0RwRAAAAEQAAAA8AAAAAAAAAAAAAAIABAAAAAHNpdGUvaW5kZXguaHRtbFBLAQItAy0ACAAIAAAAIQCcOjWFEQAAAPAAAAAKAAAAAAAAAAAAAACAAWoAAABzaXRlL2EuY3NzUEsFBgAAAAACAAIAdQAAAM8AAAAAAA==";

/** A zip64 archive of one stored file: every size and offset in zip64 fields, and a zip64 end record. */
function zip64(name: string, body: Uint8Array): Uint8Array {
	const out: number[] = [];
	const u16 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
	const u32 = (n: number) => (u16(n & 0xffff), u16((n >>> 16) & 0xffff));
	const u64 = (n: number) => (u32(n % 2 ** 32), u32(Math.floor(n / 2 ** 32)));
	const nameBytes = strToU8(name);
	u32(0x04034b50), u16(45), u16(0), u16(0), u32(0), u32(0), u32(0xffffffff), u32(0xffffffff), u16(nameBytes.length), u16(20);
	out.push(...nameBytes);
	u16(1), u16(16), u64(body.length), u64(body.length);
	out.push(...body);
	const directory = out.length;
	u32(0x02014b50), u16(45), u16(45), u16(0), u16(0), u32(0), u32(0), u32(0xffffffff), u32(0xffffffff), u16(nameBytes.length), u16(28), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff);
	out.push(...nameBytes);
	u16(1), u16(24), u64(body.length), u64(body.length), u64(0);
	const record = out.length;
	u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(1), u64(1), u64(record - directory), u64(directory);
	u32(0x07064b50), u32(0), u64(record), u32(1);
	u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0);
	return new Uint8Array(out);
}

describe("unpacking zips", () => {
	it("reads what Info-ZIP writes, stripping its top-level folder", () => {
		const files = unzipFiles(bytes(INFO_ZIP));
		expect(files.map((file) => [file.path, file.body.byteLength])).toEqual([
			["index.html", 17],
			["css/a.css", 36],
			["noise.bin", 64],
		]);
		expect(text(files[0]!.body)).toBe("<h1>streamed</h1>");
		expect(text(files[1]!.body)).toBe("p{color:red}".repeat(3));
	});

	it("reads a streamed zip, whose local headers don't know the sizes", () => {
		const files = unzipFiles(bytes(STREAMED_ZIP));
		expect(files.map((file) => [file.path, text(file.body)])).toEqual([
			["index.html", "<h1>streamed</h1>"],
			["a.css", "p{color:red}".repeat(20)],
		]);
	});

	it("reads zip64", () => {
		const files = unzipFiles(zip64("index.html", strToU8("<h1>64</h1>")));
		expect(files.map((file) => [file.path, text(file.body)])).toEqual([["index.html", "<h1>64</h1>"]]);
	});

	it("doesn't copy stored files: they're views into the upload", () => {
		const upload = zipSync({ "index.html": [strToU8("<h1>stored</h1>"), { level: 0 }], "a.css": [strToU8("p{}".repeat(50)), { level: 9 }] });
		const [index, css] = unzipFiles(upload);
		expect(index!.body.buffer).toBe(upload.buffer);
		expect(text(index!.body)).toBe("<h1>stored</h1>");
		expect(css!.body.buffer).not.toBe(upload.buffer);
		expect(text(css!.body)).toBe("p{}".repeat(50));
	});

	it("refuses a zip bomb from its headers, before inflating it", () => {
		const bomb = zipSync({ "index.html": strToU8("x"), "big.bin": new Uint8Array(LIMITS.pageBytes + 1) });
		expect(bomb.byteLength).toBeLessThan(200_000);
		expect(status(() => unzipFiles(bomb))).toBe(413);
		const many = zipSync(Object.fromEntries(Array.from({ length: LIMITS.pageFiles + 1 }, (_, i) => [`f${i}.txt`, strToU8("x")])));
		expect(status(() => unzipFiles(many))).toBe(413);
	});

	it("refuses a directory of far more entries than any page, junk and folders included, before reading it", () => {
		// 20,000 entries the reader would skip (macOS resource forks): only their number says no.
		const huge = zipSync(Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`__MACOSX/._${i}`, new Uint8Array(0)])));
		expect(status(() => unzipFiles(huge))).toBe(413);
	});

	it("stops reading the directory at the first file over the limit", () => {
		const files = LIMITS.pageFiles + 100;
		const upload = zipSync(Object.fromEntries(Array.from({ length: files }, (_, i) => [`f${i}.txt`, strToU8("x")])));
		// Wreck the directory just past the limit: a reader that went on would call it invalid (400), not too big (413).
		const entries: number[] = [];
		for (let at = 0; at + 4 <= upload.length; at++) if (upload[at] === 0x50 && upload[at + 1] === 0x4b && upload[at + 2] === 1 && upload[at + 3] === 2) entries.push(at);
		expect(entries).toHaveLength(files);
		upload.fill(0xff, entries[LIMITS.pageFiles + 1]!, entries[LIMITS.pageFiles + 50]!);
		expect(status(() => unzipFiles(upload))).toBe(413);
	});

	it("calls anything else not a valid zip", () => {
		const good = zipSync({ "index.html": strToU8("<h1>hi</h1>".repeat(20)) });
		const cases = [new Uint8Array(0), strToU8("not a zip at all"), good.subarray(0, good.length - 30), good.subarray(20)];
		for (const upload of cases) expect(status(() => unzipFiles(upload))).toBe(400);
	});
});

describe("decoding base64", () => {
	it("reads what atob reads, a slice at a time", () => {
		const data = Uint8Array.from({ length: 200_001 }, (_, i) => (i * 7919 + (i >> 8)) & 0xff);
		let binary = "";
		for (const byte of data) binary += String.fromCharCode(byte);
		const encoded = btoa(binary);
		expect(fromBase64(encoded)).toEqual(data);
		expect(fromBase64(encoded.replace(/=+$/, ""))).toEqual(data);
		expect(fromBase64(encoded.replace(/(.{76})/g, "$1\n"))).toEqual(data);
		expect(fromBase64("")).toEqual(new Uint8Array(0));
		expect(fromBase64("aGk=")).toEqual(strToU8("hi"));
		for (const bad of ["a", "aGk*", "a=Gk", `${"A".repeat(1 << 16)}=AAA`]) expect(() => fromBase64(bad)).toThrow();
	});

	it("answers 400 for a file that isn't base64", async () => {
		const response = await api("/pages", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", content: "%%%", encoding: "base64" }] }) });
		expect(response.status).toBe(400);
	});
});

describe("request bodies", () => {
	/** A body of `chunks` megabytes with no content-length, as `curl --data-binary @-` from a pipe sends it. */
	function chunked(chunks: number, first?: Uint8Array): ReadableStream<Uint8Array> {
		let sent = 0;
		return new ReadableStream({
			pull(controller) {
				if (sent === chunks) return controller.close();
				controller.enqueue(sent === 0 && first ? first : new Uint8Array(1024 * 1024));
				sent += 1;
			},
		});
	}

	it("cuts off a chunked body past the cap, zip or JSON", async () => {
		for (const type of ["application/zip", "application/json"]) {
			const request = new Request(`${PAGES}/api/pages`, { method: "POST", headers: { "content-type": type, authorization: "Bearer test-token" }, body: chunked(81), duplex: "half" } as RequestInit);
			expect(request.headers.get("content-length")).toBeNull();
			expect((await call(request)).status).toBe(413);
		}
	});

	it("takes a chunked zip under the cap", async () => {
		const upload = zipSync({ "index.html": strToU8("<h1>chunked</h1>") });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(upload.subarray(0, 10));
				controller.enqueue(upload.subarray(10));
				controller.close();
			},
		});
		const request = new Request(`${PAGES}/api/pages`, { method: "POST", headers: { "content-type": "application/zip", authorization: "Bearer test-token" }, body, duplex: "half" } as RequestInit);
		const response = await call(request);
		expect(response.status).toBe(201);
		const page = (await response.json()) as { url: string };
		expect(await (await call(page.url)).text()).toContain("chunked");
	});

	it("still refuses a declared length past the cap without reading it", async () => {
		const response = await api("/pages", { method: "POST", headers: { "content-type": "application/zip", "content-length": String(81 * 1024 * 1024) }, body: new Uint8Array(4) });
		expect(response.status).toBe(413);
	});
});

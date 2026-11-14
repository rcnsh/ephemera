import puppeteer, { TimeoutError } from "@cloudflare/puppeteer";
import { redact } from "./logging.ts";

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type BrowserBinding = Parameters<typeof puppeteer.launch>[0];

type Tab = Awaited<ReturnType<Browser["newPage"]>>;

/** Pages are shot at a laptop's viewport and scaled down to 320×200. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 0.25 };

/** How long a page gets to settle before it's shot as it is. */
const SETTLE_MS = 10_000;

/** One thumbnail to make: a whole page at `VIEWPORT`, or a mockup option cropped to its content. */
export interface Shot {
	url: string;
	kind: "page" | "option";
}

/**
 * The outcome of one shot: a PNG, "failed" if the browser ran but the page
 * couldn't be shot, or null if no browser could be had at all (which says
 * nothing about the page).
 */
export type ShotResult = Uint8Array | "failed" | null;

/**
 * Loads `url` and waits for it to settle (no network for half a second). A
 * page that keeps polling never settles, so when the wait runs out it's shot
 * as it is rather than not at all.
 */
async function load(tab: Tab, url: string): Promise<void> {
	try {
		await tab.goto(url, { waitUntil: "networkidle0", timeout: SETTLE_MS });
	} catch (error) {
		if (!(error instanceof TimeoutError)) throw error;
	}
}

/**
 * Makes each of `shots` in one browser launch, one after another, and says
 * how each went, to `onShot` as each is done and all together at the end.
 * Browser Run allows a few launches a second per account, so a dashboard
 * full of missing thumbnails must share browsers, not start one each.
 */
export async function screenshots(browserBinding: BrowserBinding, shots: Shot[], onShot?: (index: number, result: ShotResult) => Promise<void>): Promise<ShotResult[]> {
	let browser: Browser;
	try {
		browser = await puppeteer.launch(browserBinding);
	} catch (error) {
		console.warn(`launching a browser for ${shots.length} thumbnail(s) failed: ${error}`);
		return shots.map(() => null);
	}
	try {
		const results: ShotResult[] = [];
		for (const shot of shots) {
			let tab: Tab | undefined;
			try {
				tab = await browser.newPage();
				results.push(shot.kind === "page" ? await pageShot(tab, shot.url) : await optionShot(tab, shot.url));
			} catch (error) {
				console.warn(redact(`thumbnail of ${shot.url} failed: ${error}`));
				// A browser that dropped mid-batch says nothing about this page.
				results.push(browser.connected ? "failed" : null);
			} finally {
				await tab?.close().catch(() => {});
			}
			await onShot?.(results.length - 1, results.at(-1)!);
		}
		return results;
	} finally {
		await browser.close().catch(() => {});
	}
}

async function pageShot(tab: Tab, url: string): Promise<Uint8Array> {
	await tab.setViewport(VIEWPORT);
	await load(tab, url);
	return new Uint8Array(await tab.screenshot({ type: "png" }));
}

/** Mockup options are cropped to their content and scaled to fit this box. */
const OPTION_BOX = { width: 480, height: 640 };
/** The most of a long page an option's thumbnail shows. */
const MAX_HEIGHT = 2400;

/**
 * Evaluated in the page: the box around everything that paints (text,
 * images, borders, shadows, and backgrounds other than the page's own), so a
 * phone-sized mockup centred on a plain background is shot without the
 * background around it. Source text, since the Worker has no DOM types.
 */
const CONTENT_BOX = String.raw`(() => {
	const page = getComputedStyle(document.body).backgroundColor;
	const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
	const add = (rect) => {
		if (rect.width < 1 || rect.height < 1) return;
		box.left = Math.min(box.left, rect.left + scrollX);
		box.top = Math.min(box.top, rect.top + scrollY);
		box.right = Math.max(box.right, rect.right + scrollX);
		box.bottom = Math.max(box.bottom, rect.bottom + scrollY);
	};
	for (const element of document.body.querySelectorAll("*")) {
		const style = getComputedStyle(element);
		if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
		const background = style.backgroundColor;
		const paints =
			/^(IMG|SVG|CANVAS|VIDEO|IFRAME|PICTURE|INPUT|BUTTON|SELECT|TEXTAREA)$/i.test(element.tagName) ||
			style.backgroundImage !== "none" ||
			(background !== page && !/rgba\(.*,\s*0\)$|transparent/.test(background)) ||
			parseFloat(style.borderTopWidth) + parseFloat(style.borderRightWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.borderLeftWidth) > 0 ||
			style.boxShadow !== "none";
		if (paints) add(element.getBoundingClientRect());
	}
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	while (walker.nextNode()) {
		if (!walker.currentNode.textContent?.trim()) continue;
		range.selectNodeContents(walker.currentNode);
		add(range.getBoundingClientRect());
	}
	const width = document.documentElement.scrollWidth;
	const height = document.documentElement.scrollHeight;
	if (box.left === Infinity) return { x: 0, y: 0, width, height };
	const pad = 16;
	const x = Math.max(0, Math.floor(box.left - pad));
	const y = Math.max(0, Math.floor(box.top - pad));
	return { x, y, width: Math.min(width, Math.ceil(box.right + pad)) - x, height: Math.min(height, Math.ceil(box.bottom + pad)) - y };
})()`;

/** The full page, cropped to its content, then scaled down to fit `OPTION_BOX`. */
async function optionShot(tab: Tab, url: string): Promise<Uint8Array> {
	await tab.setViewport({ width: 1280, height: 800 });
	await load(tab, url);
	const box = (await tab.evaluate(CONTENT_BOX)) as { x: number; y: number; width: number; height: number };
	const height = Math.min(box.height, MAX_HEIGHT);
	const scale = Math.min(1, OPTION_BOX.width / box.width, OPTION_BOX.height / height);
	return new Uint8Array(await tab.screenshot({ type: "png", clip: { ...box, height, scale } }));
}

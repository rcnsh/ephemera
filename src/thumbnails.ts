import puppeteer from "@cloudflare/puppeteer";

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type BrowserBinding = Parameters<typeof puppeteer.launch>[0];

/** Pages are shot at a laptop's viewport and scaled down to 320×200. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 0.25 };

/** A PNG of `url` once it has settled, or null if the browser can't be had or the page won't load. */
export async function screenshot(browserBinding: BrowserBinding, url: string): Promise<Uint8Array | null> {
	let browser: Browser | undefined;
	try {
		browser = await puppeteer.launch(browserBinding);
		const tab = await browser.newPage();
		await tab.setViewport(VIEWPORT);
		await tab.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });
		return new Uint8Array(await tab.screenshot({ type: "png" }));
	} catch (error) {
		console.warn(`thumbnail of ${url} failed: ${error}`);
		return null;
	} finally {
		await browser?.close().catch(() => {});
	}
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

/**
 * PNGs of each of `urls` (the options of a mockup set), all shot with one
 * browser: the full page, cropped to its content, then scaled down to fit
 * `OPTION_BOX`. Null for each one that fails.
 */
export async function screenshotOptions(browserBinding: BrowserBinding, urls: string[]): Promise<(Uint8Array | null)[]> {
	let browser: Browser | undefined;
	try {
		browser = await puppeteer.launch(browserBinding);
		const shots: (Uint8Array | null)[] = [];
		for (const url of urls) {
			try {
				const tab = await browser.newPage();
				await tab.setViewport({ width: 1280, height: 800 });
				await tab.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });
				const box = (await tab.evaluate(CONTENT_BOX)) as { x: number; y: number; width: number; height: number };
				const height = Math.min(box.height, MAX_HEIGHT);
				const scale = Math.min(1, OPTION_BOX.width / box.width, OPTION_BOX.height / height);
				shots.push(new Uint8Array(await tab.screenshot({ type: "png", clip: { ...box, height, scale } })));
				await tab.close();
			} catch (error) {
				console.warn(`thumbnail of ${url} failed: ${error}`);
				shots.push(null);
			}
		}
		return shots;
	} catch (error) {
		console.warn(`thumbnails of ${urls.join(", ")} failed: ${error}`);
		return urls.map(() => null);
	} finally {
		await browser?.close().catch(() => {});
	}
}

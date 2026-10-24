import puppeteer from "@cloudflare/puppeteer";

/** Pages are shot at a laptop's viewport and scaled down to 320×200. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 0.25 };

/** A PNG of `url` once it has settled, or null if the browser can't be had or the page won't load. */
export async function screenshot(browserBinding: Parameters<typeof puppeteer.launch>[0], url: string): Promise<Uint8Array | null> {
	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
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

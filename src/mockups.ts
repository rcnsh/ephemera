import { FAVICON_LINK } from "./logo.ts";

/**
 * Mockup sets. A set is a page whose top-level folders are the options being
 * compared (`a/`, `compact/`, ...), each with its own index.html; a bundle
 * with just a root index.html is one option, `main`. Every option has a
 * verdict. Without a root index.html, the set's URL shows the options side
 * by side (see `mockupIndex`).
 */

export type Verdict = "pending" | "picked" | "rejected";

export const VERDICTS: readonly Verdict[] = ["pending", "picked", "rejected"];

export interface MockupOption {
	name: string;
	verdict: Verdict;
	note: string | null;
	updatedAt: number;
}

/** The option of a bundle that is only a root index.html. */
export const MAIN_OPTION = "main";

/** Longest slug in a mockup id, before its random suffix. */
const SLUG_LENGTH = 40;

/** Lowercase letters and digits joined by single hyphens, at most `max` long. */
export function slugify(text: string, max = SLUG_LENGTH): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
}

/** The options of a bundle given as its canonical paths: the top-level folders with an index.html, by name. */
export function mockupOptions(paths: string[]): string[] {
	const folders = new Set(paths.filter((path) => /^[^/]+\/index\.html$/.test(path)).map((path) => path.split("/")[0]!));
	if (folders.size) return [...folders].sort();
	return paths.includes("index.html") ? [MAIN_OPTION] : [];
}

/** The path of an option inside its set, given whether the set has a folder for it. */
export function optionPath(option: string, hasFolder: boolean): string {
	return hasFolder ? `${encodeURIComponent(option)}/` : "";
}

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page a set without a root index.html is served: its options side by
 * side, each in an iframe labelled with its folder name. Picked options get a
 * badge; rejected ones look like pending ones. Links are relative, so they
 * keep a private set's pass.
 */
export function mockupIndex(title: string, options: MockupOption[]): string {
	const figures = options
		.map((option) => {
			const path = optionPath(option.name, true);
			const picked = option.verdict === "picked";
			return `<figure${picked ? ' class="picked"' : ""}>
<figcaption><a href="${path}" target="_blank">${escape(option.name)}</a>${picked ? ' <span class="badge">picked</span>' : ""}</figcaption>
<iframe src="${path}" title="${escape(option.name)}" loading="lazy"></iframe>
</figure>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${FAVICON_LINK}
<style>
body { font: 14px/1.5 system-ui, sans-serif; margin: 1rem; color: #222; background: #f4f4f4; }
h1 { font-size: 1rem; margin: 0 0 1rem; }
.options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 1rem; }
figure { margin: 0; display: flex; flex-direction: column; gap: .4rem; }
figcaption { font-weight: 600; }
figcaption a { color: inherit; }
iframe { width: 100%; height: 85vh; border: 1px solid #ccc; border-radius: 6px; background: #fff; }
.picked iframe { border: 2px solid #1a7f37; }
.badge { font-size: .8em; font-weight: 500; color: #fff; background: #1a7f37; border-radius: 3px; padding: 0 .35rem; }
@media (prefers-color-scheme: dark) { body { color: #ddd; background: #161616; } iframe { border-color: #333; } }
</style>
<h1>${escape(title)}</h1>
<div class="options">
${figures}
</div>
</html>
`;
}

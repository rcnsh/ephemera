import { FAVICON_LINK, mark } from "./logo.ts";

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
 * The page a set without a root index.html is served. Options are usually
 * whole app screens, so each one renders at a real viewport (desktop, tablet
 * or phone) and is scaled down to fit its card rather than squeezed into it.
 * Clicking a card grows it into a full-size view, with tabs and arrow keys to
 * flip between options. State lives in the hash (`#option=a&width=phone`),
 * since a sandboxed page has no storage. Picked options get a badge and their
 * note; rejected ones look like pending ones. Links are relative, so they
 * keep a private set's pass. Motion is short, eased out, and off under
 * prefers-reduced-motion.
 */
export function mockupIndex(title: string, options: MockupOption[]): string {
	const figures = options
		.map((option, i) => {
			const path = optionPath(option.name, true);
			const name = escape(option.name);
			const hash = `#option=${encodeURIComponent(option.name)}`;
			const picked = option.verdict === "picked";
			const note = picked && option.note ? `\n<p class="note">${escape(option.note)}</p>` : "";
			return `<figure class="option${picked ? " picked" : ""}" data-option="${name}" data-src="${path}" style="--i:${Math.min(i, 12)}">
<figcaption><a class="name" href="${hash}">${name}</a>${picked ? ' <span class="badge">picked</span>' : ""}<a class="open" href="${path}" target="_blank" title="Open in a new tab" aria-label="Open ${name} in a new tab">&#8599;</a></figcaption>
<div class="screen"><iframe src="${path}" title="${name}" loading="lazy" tabindex="-1"></iframe><a class="hit" href="${hash}" aria-label="View ${name}"><span class="chip">View</span></a></div>${note}
</figure>`;
		})
		.join("\n");
	const pickedCount = options.filter((option) => option.verdict === "picked").length;
	const count = `${options.length} option${options.length === 1 ? "" : "s"}${pickedCount ? ` · ${pickedCount} picked` : ""}`;
	const jsTitle = JSON.stringify(title).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${FAVICON_LINK}
<script>document.documentElement.classList.add("js")</script>
<style>
:root {
	--bg: #f4f4f2; --surface: #fff; --text: #18181a; --muted: #6e6e73; --faint: #a1a1a6; --line: #e3e3df; --hover: #c9c9c4;
	--accent: #1a7f37; --frame: #fff; --shimmer: #ebebe7;
	--shadow: 0 1px 2px rgb(0 0 0 / .04), 0 2px 8px rgb(0 0 0 / .04);
	--shadow-hover: 0 2px 4px rgb(0 0 0 / .05), 0 12px 32px rgb(0 0 0 / .10);
	--ease: cubic-bezier(.2, .8, .2, 1);
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0c0c0d; --surface: #161618; --text: #ededef; --muted: #8e8e93; --faint: #5c5c61; --line: #262629; --hover: #3e3e43;
		--accent: #3fb950; --frame: #111113; --shimmer: #1c1c1f;
		--shadow: 0 1px 2px rgb(0 0 0 / .4), 0 2px 8px rgb(0 0 0 / .2);
		--shadow-hover: 0 2px 4px rgb(0 0 0 / .4), 0 16px 40px rgb(0 0 0 / .5);
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 14px/1.45 system-ui, -apple-system, sans-serif; color: var(--text); background: var(--bg); min-height: 100vh; -webkit-font-smoothing: antialiased; }

header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: .75rem 1rem; flex-wrap: wrap; padding: .8rem 1.5rem; background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: .6rem; min-width: 0; }
.brand svg { width: 18px; height: 18px; flex: none; color: var(--text); }
h1 { font-size: 15px; font-weight: 600; letter-spacing: -.01em; margin: 0; overflow-wrap: anywhere; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; }
.controls { margin-left: auto; display: flex; gap: .5rem; align-items: center; }

.seg { position: relative; display: inline-flex; border: 1px solid var(--line); border-radius: 9px; padding: 2px; background: var(--surface); box-shadow: var(--shadow); }
.seg .pill { position: absolute; top: 2px; bottom: 2px; left: 0; width: 0; border-radius: 7px; background: var(--line); }
.seg.ready .pill { transition: transform .25s var(--ease), width .25s var(--ease); }
.seg button { position: relative; font: inherit; font-size: 13px; color: var(--muted); background: none; border: 0; border-radius: 7px; padding: .25rem .7rem; cursor: pointer; transition: color .15s; }
.seg button:hover, .seg button[aria-pressed="true"] { color: var(--text); }
html:not(.js) .seg button[aria-pressed="true"] { background: var(--line); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

.icon { display: inline-grid; place-items: center; width: 32px; height: 32px; font: inherit; font-size: 15px; line-height: 1; color: var(--muted); background: var(--surface); border: 1px solid var(--line); border-radius: 9px; cursor: pointer; text-decoration: none; box-shadow: var(--shadow); transition: color .15s, border-color .15s, transform .1s; }
.icon:hover { color: var(--text); border-color: var(--hover); }
.icon:active { transform: scale(.96); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--card, 460px)), 1fr)); gap: 2rem 1.5rem; padding: 1.5rem; }
.option { margin: 0; min-width: 0; display: flex; flex-direction: column; gap: .6rem; }
.js .option { animation: rise .45s var(--ease) both; animation-delay: calc(var(--i) * 45ms); }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
.option figcaption { display: flex; align-items: center; gap: .5rem; min-width: 0; padding: 0 .1rem; }
.option .name { font-weight: 600; letter-spacing: -.005em; color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.option .name:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--faint); }
.option .open { margin-left: auto; color: var(--faint); text-decoration: none; padding: 0 .25rem; transition: color .15s; }
.option .open:hover { color: var(--text); }
.badge { display: inline-flex; align-items: center; gap: .25rem; font-size: 11px; font-weight: 600; letter-spacing: .01em; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 999px; padding: .1rem .55rem .1rem .45rem; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.note { margin: 0; padding: 0 .1rem; color: var(--muted); font-size: 13px; }

.screen { position: relative; width: 100%; aspect-ratio: var(--w) / var(--h); overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--frame); box-shadow: var(--shadow); transition: transform .3s var(--ease), box-shadow .3s var(--ease), border-color .2s; }
.screen iframe { position: absolute; top: 0; left: 0; width: calc(var(--w) * 1px); height: calc(var(--h) * 1px); border: 0; transform-origin: 0 0; transform: scale(var(--s, 1)); background: var(--frame); }
.js .screen iframe { opacity: 0; transition: opacity .35s var(--ease); }
.js .screen.loaded iframe { opacity: 1; }
.js .screen:not(.loaded)::before { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, var(--shimmer) 50%, transparent 70%) 0 0 / 250% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { from { background-position: 125% 0; } to { background-position: -125% 0; } }
.picked .screen { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent), var(--shadow); }
.hit { position: absolute; inset: 0; cursor: zoom-in; border-radius: inherit; }
.chip { position: absolute; right: .6rem; bottom: .6rem; font-size: 12px; font-weight: 500; color: #fff; background: rgb(20 20 22 / .72); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 999px; padding: .2rem .65rem; opacity: 0; transform: translateY(4px); transition: opacity .2s var(--ease), transform .2s var(--ease); pointer-events: none; }
@media (hover: hover) {
	.option:hover .screen { transform: translateY(-3px); box-shadow: var(--shadow-hover); border-color: var(--hover); }
	.option.picked:hover .screen { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent), var(--shadow-hover); }
	.option:hover .chip { opacity: 1; transform: none; }
}
.hit:focus-visible .chip { opacity: 1; transform: none; }
.morphing .chip { opacity: 0 !important; transition: none; }
.option .screen:active { transform: scale(.995); }

.focus { display: flex; flex-direction: column; height: calc(100vh - var(--header, 56px)); padding: .9rem 1.5rem 1.5rem; gap: .9rem; }
.focus[hidden], .grid[hidden] { display: none; }
.tabs { display: flex; align-items: center; gap: .5rem; min-width: 0; }
.tabs .list { position: relative; display: flex; gap: .15rem; overflow-x: auto; scrollbar-width: none; min-width: 0; padding: 2px; }
.tabs .list a { position: relative; flex: none; color: var(--muted); text-decoration: none; padding: .35rem .75rem; border-radius: 8px; white-space: nowrap; transition: color .15s, background-color .15s; }
.tabs .list a:hover { color: var(--text); background: color-mix(in srgb, var(--line) 50%, transparent); }
.tabs .list a[aria-current="true"] { color: var(--text); background: var(--surface); box-shadow: 0 0 0 1px var(--line), var(--shadow); font-weight: 600; }
.tabs .list a.picked::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: .45rem; vertical-align: middle; border-radius: 50%; background: var(--accent); }
.tabs .open { margin-left: auto; }
.stage { flex: 1; min-height: 0; display: flex; justify-content: center; }
.stage .screen { aspect-ratio: auto; height: 100%; width: calc(var(--w) * var(--s, 1) * 1px); max-width: 100%; box-shadow: var(--shadow-hover); }
.stage .screen iframe { height: calc(100% / var(--s, 1)); }
.js .focus:not([hidden]) { animation: fade .25s var(--ease) both; }
@keyframes fade { from { opacity: 0; } }

::view-transition-group(*) { animation-duration: .38s; animation-timing-function: var(--ease); }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: .2s; }
::view-transition-old(screen), ::view-transition-new(screen) { height: 100%; object-fit: cover; object-position: top left; }

@media (max-width: 600px) { header, .grid, .focus { padding-left: 1rem; padding-right: 1rem; } .controls { margin-left: 0; } }
@media (prefers-reduced-motion: reduce) {
	*, *::before, ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; transition: none !important; }
}
</style>
<header>
<div class="brand">${mark("hm", 7)}<h1>${escape(title)}</h1></div>
<span class="count">${count}</span>
<div class="controls">
<div class="seg" role="group" aria-label="Viewport"><span class="pill" aria-hidden="true"></span><button type="button" data-width="desktop" aria-pressed="true">Desktop</button><button type="button" data-width="tablet" aria-pressed="false">Tablet</button><button type="button" data-width="phone" aria-pressed="false">Phone</button></div>
</div>
</header>
<main class="grid">
${figures}
</main>
<section class="focus" hidden>
<nav class="tabs" aria-label="Options">
<button type="button" class="icon prev" aria-label="Previous option" title="Previous (←)">&#8592;</button>
<div class="list"></div>
<button type="button" class="icon next" aria-label="Next option" title="Next (→)">&#8594;</button>
<a class="icon open" target="_blank" title="Open in a new tab" aria-label="Open in a new tab">&#8599;</a>
<a class="icon close" href="#" title="Back to all options (Esc)" aria-label="Back to all options">&#10005;</a>
</nav>
<div class="stage"><div class="screen"><iframe title=""></iframe></div></div>
</section>
<script>
(() => {
	const SIZES = { desktop: [1440, 900, 460], tablet: [834, 1112, 320], phone: [390, 844, 220] };
	const TITLE = ${jsTitle};
	const root = document.documentElement;
	const grid = document.querySelector(".grid");
	const focus = document.querySelector(".focus");
	const list = focus.querySelector(".list");
	const stage = focus.querySelector(".screen");
	const frame = stage.querySelector("iframe");
	const open = focus.querySelector(".open");
	const seg = document.querySelector(".seg");
	const figures = [...grid.querySelectorAll(".option")];
	const options = figures.map((el) => ({ el, name: el.dataset.option, src: el.dataset.src, picked: el.classList.contains("picked") }));
	const tabs = options.map((o) => {
		const a = document.createElement("a");
		a.textContent = o.name;
		a.href = "#" + new URLSearchParams({ option: o.name });
		if (o.picked) a.className = "picked";
		list.append(a);
		return a;
	});

	// Each screen fades its iframe in once loaded, with a shimmer until then.
	const screens = [...document.querySelectorAll(".screen")];
	for (const screen of screens) {
		const f = screen.querySelector("iframe");
		f.addEventListener("load", () => f.getAttribute("src") && screen.classList.add("loaded"));
	}
	setTimeout(() => screens.forEach((s) => s.querySelector("iframe").getAttribute("src") && s.classList.add("loaded")), 4000);

	let width = "desktop";
	let current = null;
	// The option being shown or about to be: a view transition renders a frame
	// late, and a key pressed meanwhile must act on where the page is going.
	let wanted = null;
	let gridScroll = 0;

	// Grid screens scale to their width; the stage scales to whichever of
	// width or height runs out first.
	const fit = (screen) => {
		const [w, h] = SIZES[width];
		if (screen === stage) {
			const box = stage.parentElement.getBoundingClientRect();
			stage.style.setProperty("--s", Math.min(1, box.width / w, box.height / h) || 1);
		} else screen.style.setProperty("--s", screen.clientWidth / w || 1);
	};
	const header = document.querySelector("header");
	const ro = new ResizeObserver((entries) => entries.forEach((e) => {
		if (e.target === header) root.style.setProperty("--header", header.offsetHeight + "px");
		else fit(e.target === stage.parentElement ? stage : e.target);
	}));
	ro.observe(header);
	screens.forEach((s) => ro.observe(s === stage ? stage.parentElement : s));

	const movePill = () => {
		const b = seg.querySelector('[aria-pressed="true"]');
		const pill = seg.querySelector(".pill");
		pill.style.width = b.offsetWidth + "px";
		pill.style.transform = "translateX(" + b.offsetLeft + "px)";
	};

	const writeHash = (option, w) => {
		const params = new URLSearchParams();
		if (option != null) params.set("option", option);
		if (w !== "desktop") params.set("width", w);
		const next = params.toString();
		if (next !== location.hash.slice(1)) history.replaceState(null, "", next ? "#" + next : location.pathname + location.search);
	};

	const render = () => {
		const state = new URLSearchParams(location.hash.slice(1));
		width = SIZES[state.get("width")] ? state.get("width") : "desktop";
		const index = options.findIndex((o) => o.name === state.get("option"));
		const was = current;
		current = index >= 0 ? index : null;
		wanted = current;
		if (was === null && current !== null) gridScroll = scrollY;
		const [w, h, card] = SIZES[width];
		root.style.setProperty("--w", w);
		root.style.setProperty("--h", h);
		root.style.setProperty("--card", card + "px");
		document.querySelectorAll("[data-width]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.width === width)));
		movePill();
		grid.hidden = current !== null;
		focus.hidden = current === null;
		if (current !== null) {
			const o = options[current];
			if (frame.getAttribute("src") !== o.src) {
				stage.classList.remove("loaded");
				frame.src = o.src;
			}
			frame.title = o.name;
			open.href = o.src;
			tabs.forEach((t, i) => t.setAttribute("aria-current", String(i === current)));
			tabs[current].scrollIntoView({ block: "nearest", inline: "nearest" });
			document.title = o.name + " \\u2014 " + TITLE;
		} else {
			document.title = TITLE;
			if (was !== null) scrollTo(0, gridScroll);
		}
		screens.forEach(fit);
	};

	// Opening and closing morph the card's screen into the stage and back,
	// where the browser has view transitions; elsewhere the view just fades.
	const morph = (from, to, update) => {
		if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
		root.classList.add("morphing");
		from.style.viewTransitionName = "screen";
		document.startViewTransition(() => {
			from.style.viewTransitionName = "";
			update();
			to.style.viewTransitionName = "screen";
		}).finished.finally(() => { to.style.viewTransitionName = ""; root.classList.remove("morphing"); });
	};

	const go = (option) => {
		const before = wanted;
		const update = () => { writeHash(option, width); render(); };
		const target = options.findIndex((o) => o.name === option);
		wanted = target >= 0 ? target : null;
		if (before === null && target >= 0) morph(options[target].el.querySelector(".screen"), stage, update);
		else if (before !== null && option == null) morph(stage, options[before].el.querySelector(".screen"), update);
		else update();
	};
	const step = (d) => wanted !== null && go(options[(wanted + d + options.length) % options.length].name);

	document.querySelectorAll("[data-width]").forEach((b) => b.addEventListener("click", () => {
		writeHash(current === null ? null : options[current].name, b.dataset.width);
		render();
	}));
	focus.querySelector(".prev").addEventListener("click", () => step(-1));
	focus.querySelector(".next").addEventListener("click", () => step(1));
	focus.querySelector(".close").addEventListener("click", (e) => { e.preventDefault(); go(null); });
	document.addEventListener("click", (e) => {
		const a = e.target.closest('a[href^="#option="]');
		if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		go(new URLSearchParams(a.getAttribute("href").slice(1)).get("option"));
	});
	document.addEventListener("keydown", (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey || wanted === null) return;
		if (e.key === "ArrowLeft") step(-1);
		else if (e.key === "ArrowRight") step(1);
		else if (e.key === "Escape") go(null);
	});
	addEventListener("hashchange", render);
	render();
	requestAnimationFrame(() => seg.classList.add("ready"));
})();
</script>
</html>
`;
}

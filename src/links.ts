import type { PageFile } from "./files.ts";

/** True for `/x` but not `//host/x`. */
function isRootRelative(url: string): boolean {
	return url.startsWith("/") && !url.startsWith("//");
}

function prefix(url: string, base: string): string {
	if (!isRootRelative(url) || url === base || url.startsWith(`${base}/`)) return url;
	return base + url;
}

const URL_ATTRIBUTES = ["href", "src", "action", "poster", "formaction", "data"];

/**
 * Rewrites root-relative URLs in HTML attributes so `/style.css` on page
 * `abc` becomes `/abc/style.css`. Text inside <script> and <style> isn't
 * touched; publishing warns about those instead.
 */
export function rewriteLinks(response: Response, id: string): Response {
	const base = `/${id}`;
	const rewriter = new HTMLRewriter();
	for (const attribute of URL_ATTRIBUTES) {
		rewriter.on(`[${attribute}]`, {
			element(element) {
				element.setAttribute(attribute, prefix(element.getAttribute(attribute)!, base));
			},
		});
	}
	rewriter.on("[srcset]", {
		element(element) {
			const srcset = element.getAttribute("srcset")!;
			element.setAttribute(
				"srcset",
				srcset
					.split(",")
					.map((candidate) => candidate.replace(/^(\s*)(\S+)/, (_, space: string, url: string) => space + prefix(url, base)))
					.join(","),
			);
		},
	});
	return rewriter.transform(response);
}

const PATTERNS: { types: RegExp; pattern: RegExp }[] = [
	// CSS: url(/x) and @import "/x"
	{ types: /\.(css|html?)$/, pattern: /url\(\s*['"]?(\/(?!\/)[^'")\s]*)/g },
	{ types: /\.(css|html?)$/, pattern: /@import\s+['"](\/(?!\/)[^'"]*)/g },
	// JS: fetch("/x"), import("/x"), from "/x", new URL("/x"), new Worker("/x"), location = "/x"
	{ types: /\.(m?js|html?)$/, pattern: /(?:fetch|import|URL|Worker|open)\(\s*['"`](\/(?!\/)[^'"`]*)/g },
	{ types: /\.(m?js|html?)$/, pattern: /\bfrom\s*['"](\/(?!\/)[^'"]*)/g },
	{ types: /\.(m?js|html?)$/, pattern: /(?:\blocation|\.href)\s*=\s*['"`](\/(?!\/)[^'"`]*)/g },
];

const MAX_WARNINGS = 20;

/**
 * Finds root-relative URLs that `rewriteLinks` can't fix: ones inside CSS,
 * JS, and inline <style>/<script>. It's a heuristic, so it only warns.
 */
export function rootRelativeWarnings(files: PageFile[]): string[] {
	const decoder = new TextDecoder();
	const warnings: string[] = [];
	for (const file of files) {
		const applicable = PATTERNS.filter(({ types }) => types.test(file.path));
		if (!applicable.length || file.body.byteLength > 2_000_000) continue;
		const text = decoder.decode(file.body);
		const found = new Set<string>();
		for (const { pattern } of applicable) {
			for (const match of text.matchAll(pattern)) found.add(match[1]!);
		}
		for (const url of found) {
			if (warnings.length === MAX_WARNINGS) return [...warnings, "…and more; use relative paths throughout"];
			warnings.push(`${file.path}: "${url}" is root-relative and will resolve to p.rcn.sh${url}, outside this page. Use a relative path ("${url.slice(1)}") instead.`);
		}
	}
	return warnings;
}

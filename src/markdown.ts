import { marked } from "marked";

const CSS = `
body { font: 16px/1.6 system-ui, -apple-system, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #222; background: #fff; }
h1, h2, h3 { line-height: 1.25; }
pre, code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: #f5f5f5; padding: 0.8rem 1rem; overflow-x: auto; border-radius: 4px; }
:not(pre) > code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 3px; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ddd; padding: 0.3rem 0.6rem; text-align: left; }
blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid #ddd; color: #555; }
img { max-width: 100%; }
a { color: #0645ad; }
@media (prefers-color-scheme: dark) {
	body { color: #ddd; background: #161616; }
	pre, :not(pre) > code { background: #262626; }
	th, td { border-color: #444; }
	blockquote { border-color: #444; color: #aaa; }
	a { color: #8ab4f8; }
}
`;

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A whole HTML page for a Markdown document, titled by `title` or else its first heading. */
export function markdownPage(markdown: string, title?: string | null): string {
	const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title || heading || "Page")}</title>
<style>${CSS}</style>
${marked.parse(markdown, { async: false, gfm: true })}
</html>
`;
}

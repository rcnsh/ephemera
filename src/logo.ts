/**
 * The mark: a page whose outline fades out towards the bottom. Drawn in
 * currentColor; `id` names its gradient, which must be unique in a document.
 */
export function mark(id: string, strokeWidth = 6, attributes = ""): string {
	return `<svg viewBox="0 0 100 100" aria-hidden="true" ${attributes}>
<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset=".35" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
<g fill="none" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
<path d="M22 90V10h38l18 18v62" stroke="url(#${id})"/>
<path d="M60 10v18h18" stroke="currentColor"/>
</g>
</svg>`;
}

/** The favicon: a heavier mark that follows the browser's light or dark theme. */
export const FAVICON = mark("m", 9, 'xmlns="http://www.w3.org/2000/svg"').replace(
	"<defs>",
	"<style>svg{color:#111}@media (prefers-color-scheme:dark){svg{color:#f5f5f5}}</style><defs>",
);

export const FAVICON_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

export function favicon(): Response {
	return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}

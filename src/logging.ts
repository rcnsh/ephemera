/**
 * What the Worker writes to Workers Logs. Some paths carry a secret that opens
 * something on its own: a private page's pass (`/<id>/~<pass>/…`) and an
 * upload token (`/upload/<token>`). Logs are kept for days and a pass can last
 * 30, so nothing reaches a log without going through `redact`.
 */

/**
 * `text` (a path, a URL, or a message that contains them) with every pass and
 * upload token replaced. Any path segment starting with `~` counts as a pass,
 * signed or not, and so does its percent-encoded `%7E` form.
 */
export function redact(text: string): string {
	return text
		.replace(/\/(?:~|%7e)[^/?#\s"'<>]*/gi, "/~redacted")
		.replace(/(^|\/\/[^/\s]+)\/upload\/[^?#\s"'<>]+/g, "$1/upload/redacted");
}

/** One log line per request, in place of Cloudflare's invocation log, which has the full URL. */
export function logRequest(request: Request, response: Response, ms: number): void {
	const { hostname, pathname } = new URL(request.url);
	console.log(JSON.stringify({ method: request.method, host: hostname, path: redact(pathname), status: response.status, ms: Math.round(ms) }));
}

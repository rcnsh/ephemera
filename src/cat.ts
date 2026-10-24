const CATAAS = "https://cataas.com/cat";

const ROOT_PAGE = (nonce: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🐈</title>
<style>
html, body { margin: 0; height: 100%; background: #111; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
<img src="/cat.jpg?${nonce}" alt="A random cat">
</html>
`;

// Shown when cataas is down or slow.
const FALLBACK_CAT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400">
<rect width="200" height="200" fill="#111"/>
<g fill="#e8a14f">
<path d="M45 95 L55 35 L85 75 Z"/><path d="M155 95 L145 35 L115 75 Z"/>
<ellipse cx="100" cy="115" rx="60" ry="52"/>
</g>
<g fill="#111">
<ellipse cx="78" cy="108" rx="7" ry="10"/><ellipse cx="122" cy="108" rx="7" ry="10"/>
<path d="M93 128 L107 128 L100 136 Z"/>
</g>
<g stroke="#111" stroke-width="2" stroke-linecap="round" fill="none">
<path d="M100 136 Q92 146 84 140"/><path d="M100 136 Q108 146 116 140"/>
<path d="M70 132 L35 126"/><path d="M70 138 L36 142"/><path d="M130 132 L165 126"/><path d="M130 138 L164 142"/>
</g>
</svg>`;

export function rootPage(): Response {
	const nonce = crypto.randomUUID().slice(0, 8);
	return new Response(ROOT_PAGE(nonce), { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A random cat from cataas, or the built-in one if cataas doesn't answer with an image within 3 seconds. */
export async function cat(): Promise<Response> {
	try {
		const upstream = await fetch(CATAAS, { signal: AbortSignal.timeout(3000), headers: { accept: "image/*" } });
		const type = upstream.headers.get("content-type") ?? "";
		if (upstream.ok && type.startsWith("image/")) {
			return new Response(upstream.body, { headers: { "content-type": type } });
		}
		await upstream.body?.cancel();
	} catch {
		// Fall through to the built-in cat.
	}
	return new Response(FALLBACK_CAT, { headers: { "content-type": "image/svg+xml" } });
}

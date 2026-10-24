import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-10-19",
				d1Databases: ["DB"],
				r2Buckets: ["BUCKET"],
				bindings: {
					EPHEMERA_TOKEN: "test-token",
					PAGES_HOST: "p.rcn.sh",
					ADMIN_HOST: "ephemera.rcn.sh",
					ACCESS_AUD: "test-aud",
				},
			},
		}),
	],
});

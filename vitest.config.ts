import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
	test: {
		setupFiles: ["./test/setup.ts"],
	},
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-10-19",
				d1Databases: ["DB"],
				r2Buckets: ["BUCKET"],
				// Same limits as cloudflare.config.ts.
				ratelimits: {
					PASSWORD_GUESSES: { namespace_id: "4831", simple: { limit: 5, period: 60 } },
					PAGE_PASSWORD_GUESSES: { namespace_id: "4832", simple: { limit: 30, period: 60 } },
				},
				bindings: {
					EPHEMERA_TOKEN: "test-token",
					PAGES_HOST: "pages.example.com",
					ADMIN_HOST: "admin.example.com",
					ACCESS_AUD: "test-aud",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
});

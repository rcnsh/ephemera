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
				bindings: {
					EPHEMERA_TOKEN: "test-token",
					PAGES_HOST: "p.rcn.sh",
					ADMIN_HOST: "ephemera.rcn.sh",
					ACCESS_AUD: "test-aud",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
});

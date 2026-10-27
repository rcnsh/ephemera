import { existsSync } from "node:fs";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Deployment settings live in .env (see .env.example), which cf also reads for credentials.
if (existsSync(".env")) process.loadEnvFile(".env");

function setting(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} in .env (see .env.example)`);
	return value;
}

const pagesHost = setting("PAGES_HOST");
const adminHost = setting("ADMIN_HOST");

export default defineConfig({
	worker: {
		name: "ephemera",
		compatibilityDate: "2026-10-19",
		entrypoint,
		workersDev: false,
		domains: [pagesHost, adminHost],
		triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
		observability: { enabled: true },
		env: {
			DB: bindings.d1({ name: "ephemera" }),
			BUCKET: bindings.r2({ name: "ephemera" }),
			// Browser Rendering, for the dashboard's thumbnails.
			BROWSER: bindings.browser(),
			EPHEMERA_TOKEN: bindings.secret(),
			PAGES_HOST: bindings.text(pagesHost),
			ADMIN_HOST: bindings.text(adminHost),
			// Audience tag of the Access application guarding ADMIN_HOST.
			ACCESS_AUD: bindings.text(setting("ACCESS_AUD")),
		},
	},
});

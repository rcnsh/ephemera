import { existsSync } from "node:fs";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Deployment settings live in .env (see .env.example), which cf also reads for credentials.
if (existsSync(".env")) process.loadEnvFile(".env");

// `pnpm typecheck` sets EPHEMERA_TYPES_ONLY=1: generating types only needs the
// bindings' shapes, so a clean checkout (and CI) gets placeholders. Everything
// else, deploying included, needs the real values.
const typesOnly = process.env.EPHEMERA_TYPES_ONLY === "1";

function setting(name: string): string {
	const value = process.env[name];
	if (value) return value;
	if (typesOnly) return `${name.toLowerCase().replaceAll("_", "-")}.example.invalid`;
	throw new Error(`Set ${name} in .env (see .env.example)`);
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
		// Invocation logs record each request's full URL, and passes and upload
		// tokens are in the path, so they're off; the Worker logs each request
		// itself, with those redacted (src/logging.ts).
		observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
		env: {
			DB: bindings.d1({ name: "ephemera" }),
			BUCKET: bindings.r2({ name: "ephemera" }),
			// Browser Rendering, for the dashboard's thumbnails.
			BROWSER: bindings.browser(),
			// Password guesses at a private page, per client address and per page (see unlock in src/privacy.ts).
			// Namespace IDs are this account's choice; vitest.config.ts uses the same limits.
			PASSWORD_GUESSES: bindings.rateLimit({ namespace: "4831", simple: { limit: 5, period: 60 } }),
			PAGE_PASSWORD_GUESSES: bindings.rateLimit({ namespace: "4832", simple: { limit: 30, period: 60 } }),
			EPHEMERA_TOKEN: bindings.secret(),
			PAGES_HOST: bindings.text(pagesHost),
			ADMIN_HOST: bindings.text(adminHost),
			// Audience tag of the Access application guarding ADMIN_HOST.
			ACCESS_AUD: bindings.text(setting("ACCESS_AUD")),
		},
	},
});

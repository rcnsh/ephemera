import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "ephemera",
		compatibilityDate: "2026-10-19",
		entrypoint,
		workersDev: false,
		domains: ["p.rcn.sh", "ephemera.rcn.sh"],
		triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
		observability: { enabled: true },
		env: {
			DB: bindings.d1({ name: "ephemera" }),
			BUCKET: bindings.r2({ name: "ephemera" }),
			EPHEMERA_TOKEN: bindings.secret(),
			PAGES_HOST: bindings.text("p.rcn.sh"),
			ADMIN_HOST: bindings.text("ephemera.rcn.sh"),
			// Audience tag of the Access application guarding ADMIN_HOST.
			ACCESS_AUD: bindings.text("set-after-access-app-is-created"),
		},
	},
});

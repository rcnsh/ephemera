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
			// Browser Rendering, for the dashboard's thumbnails.
			BROWSER: bindings.browser(),
			EPHEMERA_TOKEN: bindings.secret(),
			PAGES_HOST: bindings.text("p.rcn.sh"),
			ADMIN_HOST: bindings.text("ephemera.rcn.sh"),
			// Audience tag of the Access application guarding ADMIN_HOST.
			ACCESS_AUD: bindings.text("b7ad86d15465a5788e12e6c7d717aa15512f7536c86f6958ebf48402169adcdd"),
		},
	},
});

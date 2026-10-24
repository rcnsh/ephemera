import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// `reset()` wipes D1 after each test, so the schema goes back in before each one.
beforeEach(async () => {
	await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, vi } from "vitest";
import { clearLookupMemo } from "../src/pages.ts";

// No real browser in tests. Mocked here, before the Worker loads, so the
// Worker gets the mock too; tests set what it returns.
vi.mock("../src/thumbnails.ts", () => ({
	screenshots: vi.fn(async (_browser: unknown, shots: unknown[]) => shots.map(() => null)),
}));

// `reset()` wipes D1 after each test, so the schema goes back in before each one.
beforeEach(async () => {
	// Page lookups are memoized per isolate for a moment; each test starts from D1.
	clearLookupMemo();
	await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

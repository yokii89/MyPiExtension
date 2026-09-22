import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "yoki-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;
delete process.env.WEB_SEARCH_PROVIDER;

// The suite asserts the Unix terminal transport used by Warp. Keep that
// contract deterministic when the tests themselves run under Windows; native
// Windows behavior is exercised separately by the transport's stdout branch.
Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// `completeSimple` lives on the /compat entrypoint since pi 0.80; production
// code resolves it via loadCompleteSimple(), which prefers /compat, so the
// stub must be registered there for the shim to pick it up.
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// Package modules are imported dynamically inside beforeEach (NOT statically at
// the top of this file) by deliberate design — DO NOT "optimize" by hoisting.
//
// Two failure modes that hoisting re-introduces:
//
// 1. Real-homedir leak: ES module spec hoists `import` statements above all
//    other top-level statements. If these imports were static here they would
//    execute BEFORE `process.env.HOME = TEST_HOME` above, so production
//    modules' `homedir()` captures would resolve to the developer's REAL
//    $HOME — silently reading/writing actual ~/.config/* files during tests.
//
// 2. vi.mock bypass: many test files register `vi.mock("node:fs")` (or other
//    transitive mocks) and rely on being the FIRST loader of the package
//    under test. If setup.ts statically imports those packages first, the
//    package's bindings are sealed against unmocked deps and the test's
//    vi.mock never reaches the cached module.
//
// Cost: cold-cache resolution of the dynamic imports below can exceed
// vitest's default 10s hookTimeout on the very first test of a worker. The
// hookTimeout is therefore raised in vitest.config.ts. The cost is paid once
// per worker; subsequent tests reuse the module cache and beforeEach is fast.
beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.WEB_SEARCH_PROVIDER;

	// yoki-todo may be absent from partial checkouts; don't fail the whole suite.
	// Variable specifier keeps tsc/vite from hard-failing when the package is missing.
	const todoSpec = ["..", "packages", "yoki-todo", "todo.js"].join("/");
	try {
		const todo = (await import(/* @vite-ignore */ todoSpec)) as {
			__resetState?: () => void;
		};
		todo.__resetState?.();
	} catch {
		// optional package not present
	}

	const titleSpinner = await import("../packages/yoki-warp-notify/title-spinner.js");
	titleSpinner.__resetState();

	const warpIndex = await import("../packages/yoki-warp-notify/index.js");
	warpIndex.__resetState();

	const piAgentSettings = join(process.env.HOME!, ".pi", "agent", "settings.json");
	const xdgPiAgentDir = join(process.env.HOME!, ".config", "pi", "agent");
	const todoConfig = join(process.env.HOME!, ".config", "yoki-todo", "config.json");
	const askUserQuestionConfig = join(process.env.HOME!, ".config", "yoki-ask-user-question", "config.json");
	const webSearchConfig = join(process.env.HOME!, ".pi", "web-search.json");
	rmSync(piAgentSettings, { force: true });
	rmSync(xdgPiAgentDir, { recursive: true, force: true });
	rmSync(todoConfig, { force: true });
	rmSync(askUserQuestionConfig, { force: true });
	rmSync(webSearchConfig, { force: true });

	// Clean global agent dir parent (`~/.pi/agent/`) — not just `~/.pi/agent/agents/` —
	// so tests that place a regular file at `~/.pi/agent` can write into a
	// clean slot, and so no test inherits an empty-dir residue from a prior worker run.
	const globalAgentDir = join(process.env.HOME!, ".pi", "agent");
	rmSync(globalAgentDir, { recursive: true, force: true });
});

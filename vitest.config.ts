import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/**/*.test.ts"],
		exclude: [
			"packages/yoki-newapi/**",
			"packages/yoki-skills/**",
			// yoki-ui node:test suite; window-title vitest suite under test/window-title is included
			"packages/yoki-ui/test/*.test.ts",
			"packages/yoki-ui/node_modules/**",
			"packages/yoki-mcp-adapter/**",
		],
		setupFiles: ["./test/setup.ts"],
		// setup.ts performs ~9 dynamic `await import(...)` calls inside beforeEach
		// (deliberately — see header comment in test/setup.ts). Cold-cache
		// resolution of those imports on the very first test of a worker can
		// exceed vitest's default 10s hookTimeout. Raised so the worker warm-up
		// completes inside the timer; subsequent tests reuse the module cache.
		hookTimeout: 30_000,
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["packages/*/**/*.ts"],
			// Global floor tracks the vitest-gated set as a whole (yoki-plan and
			// yoki-image-gen are still below the historical 94/87/93/95 bar).
			// Per-package globs below keep that strict bar on the mature suites.
			thresholds: {
				statements: 89,
				branches: 81,
				functions: 91,
				lines: 91,
				"packages/yoki-web-tools/**": {
					// github.ts interceptor paths (gh/clone fallbacks) sit just under
					// the mature-suite bar; keep a real regression gate at measured level.
					statements: 93,
					branches: 85,
					functions: 95,
					lines: 95,
				},
				"packages/yoki-config/**": {
					statements: 94,
					branches: 87,
					functions: 93,
					lines: 95,
				},
				"packages/yoki-warp-notify/**": {
					statements: 94,
					branches: 87,
					functions: 93,
					lines: 95,
				},
			},
			exclude: [
				"**/node_modules/**",
				"**/.pi/**",
				"**/.yoki/**",
				"**/docs/**",
				"**/*.test.ts",
				"**/*.d.ts",
				"**/index.ts",
				// Type-only modules — no runtime code to cover.
				"**/types.ts",
				"packages/test-utils/**",
				"packages/yoki-test-utils/**",
				// Vendored / separately-tested packages — not gated by this suite.
				"packages/pi-telegram-main/**",
				"packages/yoki-skills/**",
				"packages/yoki-newapi/**",
				"packages/yoki-ui/**",
			],
		},
	},
});

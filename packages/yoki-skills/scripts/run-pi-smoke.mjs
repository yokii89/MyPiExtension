import { spawnSync } from "node:child_process";

// Drop inherited node:test child context so --test actually runs this file.
const env = { ...process.env, PI_CODEX_SKILLS_SMOKE: "1" };
delete env.NODE_TEST_CONTEXT;

const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "test/pi-loader-smoke.test.ts"], {
	cwd: process.cwd(),
	stdio: "inherit",
	env,
});

process.exitCode = result.status ?? 1;

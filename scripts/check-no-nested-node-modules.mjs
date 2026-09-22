#!/usr/bin/env node
// Workspace hygiene: dependencies must resolve from the root node_modules via
// npm workspaces. A per-package node_modules or lockfile means someone ran
// `npm install` inside a package (e.g. pi installing an extension standalone);
// left in place, those stale copies shadow the hoisted versions and drift.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const packagesDir = join(import.meta.dirname, "..", "packages");
const violations = [];

for (const name of readdirSync(packagesDir)) {
	const pkgDir = join(packagesDir, name);
	if (!existsSync(join(pkgDir, "package.json"))) continue;
	if (existsSync(join(pkgDir, "node_modules"))) {
		violations.push(`${name}/node_modules`);
	}
	if (existsSync(join(pkgDir, "package-lock.json"))) {
		violations.push(`${name}/package-lock.json`);
	}
}

if (violations.length > 0) {
	console.error(`❌ Nested dependency artifacts found:\n${violations.map((v) => `  - packages/${v}`).join("\n")}`);
	console.error("   Delete them and run `npm install` from the workspace root instead.");
	process.exit(1);
}
console.log("✅ No nested node_modules or lockfiles in packages/.");

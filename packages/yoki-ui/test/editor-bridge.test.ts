import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPlanBridge, type YokiPlanBridgeLike } from "../yoki_ui/editor.ts";

const BRIDGE_SYMBOL = Symbol.for("@yoki/yoki-plan:bridge");

describe("yoki_ui plan bridge lookup", () => {
	it("returns undefined when bridge is absent", () => {
		delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
		assert.equal(getPlanBridge(), undefined);
	});

	it("returns bridge when isLoaded() is true", () => {
		const bridge: YokiPlanBridgeLike = {
			isLoaded: () => true,
			getMode: () => "plan",
			toggleMode: async () => "edit",
			openModelUI: async () => {},
		};
		(globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
		assert.equal(getPlanBridge(), bridge);
		delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
	});

	it("ignores bridge when isLoaded() is false", () => {
		const bridge: YokiPlanBridgeLike = {
			isLoaded: () => false,
			getMode: () => "edit",
			toggleMode: async () => "edit",
			openModelUI: async () => {},
		};
		(globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
		assert.equal(getPlanBridge(), undefined);
		delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
	});
});

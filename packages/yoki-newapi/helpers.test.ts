/**
 * Unit tests for pure helpers in pi-provider-newapi (no network).
 * Run from this directory:
 *   node ../../node_modules/vitest/dist/cli.js --run helpers.test.ts
 * or with vitest if linked.
 */

import { describe, expect, it } from "vitest";
import {
	extractApiKeyFromCodexAuth,
	extractTomlString,
	mapReasoningEffort,
	mapWireApi,
	normalizeBaseUrl,
	stubModelDef,
} from "./helpers.ts";

describe("normalizeBaseUrl", () => {
	it("strips trailing slashes and /v1", () => {
		expect(normalizeBaseUrl("http://host:8317/v1")).toBe("http://host:8317");
		expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com");
		expect(normalizeBaseUrl("https://api.example.com///")).toBe("https://api.example.com");
		expect(normalizeBaseUrl("  https://x.com  ")).toBe("https://x.com");
	});
});

describe("mapWireApi", () => {
	it("maps responses to openai-responses", () => {
		expect(mapWireApi("responses")).toBe("openai-responses");
		expect(mapWireApi("Responses")).toBe("openai-responses");
	});

	it("maps chat/completions/absent to openai-completions", () => {
		expect(mapWireApi(undefined)).toBe("openai-completions");
		expect(mapWireApi("")).toBe("openai-completions");
		expect(mapWireApi("chat")).toBe("openai-completions");
		expect(mapWireApi("completions")).toBe("openai-completions");
	});

	it("throws on unknown wire_api", () => {
		expect(() => mapWireApi("websocket")).toThrow(/Unsupported Codex wire_api/);
	});
});

describe("mapReasoningEffort", () => {
	it("maps known efforts", () => {
		expect(mapReasoningEffort("minimal")).toBe("minimal");
		expect(mapReasoningEffort("low")).toBe("low");
		expect(mapReasoningEffort("medium")).toBe("medium");
		expect(mapReasoningEffort("high")).toBe("high");
		expect(mapReasoningEffort("xhigh")).toBe("xhigh");
		expect(mapReasoningEffort("max")).toBe("max");
		expect(mapReasoningEffort("MAX")).toBe("max");
	});

	it("returns undefined for unmapped", () => {
		expect(mapReasoningEffort(undefined)).toBeUndefined();
		expect(mapReasoningEffort("")).toBeUndefined();
		expect(mapReasoningEffort("ultra")).toBeUndefined();
		expect(mapReasoningEffort("off")).toBeUndefined();
	});
});

describe("extractTomlString", () => {
	const sample = `
model_provider = "custom"
model = "grok-4.5"
model_reasoning_effort = "max"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "http://216.195.211.206:8317/v1"

[model_providers.other]
base_url = "https://other.example/v1"
wire_api = "chat"
`;

	it("reads top-level keys", () => {
		expect(extractTomlString(sample, "model_provider")).toBe("custom");
		expect(extractTomlString(sample, "model")).toBe("grok-4.5");
		expect(extractTomlString(sample, "model_reasoning_effort")).toBe("max");
	});

	it("reads section keys", () => {
		expect(extractTomlString(sample, "base_url", "model_providers.custom")).toBe(
			"http://216.195.211.206:8317/v1",
		);
		expect(extractTomlString(sample, "wire_api", "model_providers.custom")).toBe("responses");
		expect(extractTomlString(sample, "wire_api", "model_providers.other")).toBe("chat");
	});
});

describe("extractApiKeyFromCodexAuth", () => {
	it("prefers OPENAI_API_KEY", () => {
		expect(
			extractApiKeyFromCodexAuth({ OPENAI_API_KEY: "sk-abc", tokens: { access_token: "tok" } }),
		).toBe("sk-abc");
	});

	it("falls back to tokens.access_token", () => {
		expect(extractApiKeyFromCodexAuth({ tokens: { access_token: " tok " } })).toBe("tok");
	});

	it("returns undefined when missing", () => {
		expect(extractApiKeyFromCodexAuth({})).toBeUndefined();
		expect(extractApiKeyFromCodexAuth(null)).toBeUndefined();
	});
});

describe("stubModelDef", () => {
	it("builds a selectable model entry", () => {
		const m = stubModelDef("grok-4.5");
		expect(m.id).toBe("grok-4.5");
		expect(m.name).toBe("grok-4.5");
		expect(m.reasoning).toBe(true);
	});
});

describe("codex config integration (synthetic)", () => {
	it("yields responses + model + thinking from typical CC Switch config", () => {
		const config = `
model_provider = "custom"
model = "grok-4.5"
model_reasoning_effort = "max"

[model_providers.custom]
wire_api = "responses"
base_url = "http://216.195.211.206:8317/v1"
`;
		const provider = extractTomlString(config, "model_provider");
		const section = `model_providers.${provider}`;
		const baseUrl = normalizeBaseUrl(extractTomlString(config, "base_url", section)!);
		const api = mapWireApi(extractTomlString(config, "wire_api", section));
		const model = extractTomlString(config, "model");
		const thinking = mapReasoningEffort(extractTomlString(config, "model_reasoning_effort"));

		expect(baseUrl).toBe("http://216.195.211.206:8317");
		expect(api).toBe("openai-responses");
		expect(model).toBe("grok-4.5");
		expect(thinking).toBe("max");
	});
});

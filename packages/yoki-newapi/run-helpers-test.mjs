/**
 * Standalone runner for helpers (no vitest / no network).
 *   node myExtension/pi-provider-newapi/run-helpers-test.mjs
 */

import {
	extractApiKeyFromCodexAuth,
	extractTomlString,
	mapReasoningEffort,
	mapWireApi,
	normalizeBaseUrl,
	stubModelDef,
} from "./helpers.ts";

let failed = 0;
function assert(cond, msg) {
	if (!cond) {
		failed++;
		console.error("FAIL:", msg);
	} else {
		console.log("ok:", msg);
	}
}
function eq(a, b, msg) {
	assert(a === b, `${msg} (got ${JSON.stringify(a)} expected ${JSON.stringify(b)})`);
}

// normalizeBaseUrl
eq(normalizeBaseUrl("http://host:8317/v1"), "http://host:8317", "strip /v1");
eq(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com", "strip /v1/");
eq(normalizeBaseUrl("https://api.example.com///"), "https://api.example.com", "strip slashes");
eq(normalizeBaseUrl("  https://x.com  "), "https://x.com", "trim");

// mapWireApi
eq(mapWireApi("responses"), "openai-responses", "responses");
eq(mapWireApi("Responses"), "openai-responses", "Responses case");
eq(mapWireApi(undefined), "openai-completions", "undefined");
eq(mapWireApi(""), "openai-completions", "empty");
eq(mapWireApi("chat"), "openai-completions", "chat");
eq(mapWireApi("completions"), "openai-completions", "completions");
let threw = false;
try {
	mapWireApi("websocket");
} catch {
	threw = true;
}
assert(threw, "unknown wire_api throws");

// mapReasoningEffort
for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
	eq(mapReasoningEffort(level), level, `effort ${level}`);
}
eq(mapReasoningEffort("MAX"), "max", "effort MAX");
eq(mapReasoningEffort(undefined), undefined, "effort undefined");
eq(mapReasoningEffort("ultra"), undefined, "effort ultra");
eq(mapReasoningEffort("off"), undefined, "effort off");

// extractTomlString
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
eq(extractTomlString(sample, "model_provider"), "custom", "top model_provider");
eq(extractTomlString(sample, "model"), "grok-4.5", "top model");
eq(extractTomlString(sample, "model_reasoning_effort"), "max", "top effort");
eq(
	extractTomlString(sample, "base_url", "model_providers.custom"),
	"http://216.195.211.206:8317/v1",
	"section base_url",
);
eq(extractTomlString(sample, "wire_api", "model_providers.custom"), "responses", "section wire_api");
eq(extractTomlString(sample, "wire_api", "model_providers.other"), "chat", "other wire_api");

// extractApiKeyFromCodexAuth
eq(
	extractApiKeyFromCodexAuth({ OPENAI_API_KEY: "sk-abc", tokens: { access_token: "tok" } }),
	"sk-abc",
	"prefer OPENAI_API_KEY",
);
eq(extractApiKeyFromCodexAuth({ tokens: { access_token: " tok " } }), "tok", "tokens.access_token");
eq(extractApiKeyFromCodexAuth({}), undefined, "empty auth");
eq(extractApiKeyFromCodexAuth(null), undefined, "null auth");

// stubModelDef
const m = stubModelDef("grok-4.5");
eq(m.id, "grok-4.5", "stub id");
eq(m.reasoning, true, "stub reasoning");

// integration
const provider = extractTomlString(sample, "model_provider");
const section = `model_providers.${provider}`;
const baseUrl = normalizeBaseUrl(extractTomlString(sample, "base_url", section));
const api = mapWireApi(extractTomlString(sample, "wire_api", section));
const model = extractTomlString(sample, "model");
const thinking = mapReasoningEffort(extractTomlString(sample, "model_reasoning_effort"));
eq(baseUrl, "http://216.195.211.206:8317", "integration base");
eq(api, "openai-responses", "integration api");
eq(model, "grok-4.5", "integration model");
eq(thinking, "max", "integration thinking");

if (failed) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");

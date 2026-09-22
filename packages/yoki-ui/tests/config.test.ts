import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaults } from "../yoki_ui/config.ts";

describe("yoki_ui defaults", () => {
	it("starts with yoki_themes theme", () => {
		assert.equal(defaults.theme, "yoki_themes");
		assert.equal(defaults.statusline.context, "auto");
		assert.equal(defaults.statusline.icon, true);
	});
});

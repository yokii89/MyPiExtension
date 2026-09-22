import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type StatuslineConfig = {
	icon: boolean;
	directory: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	context: boolean | "auto";
	model: boolean;
	usage: boolean;
	extensionStatuses: boolean;
};

export type YokiUiConfig = {
	theme: string;
	statusline: StatuslineConfig;
};

export const defaults: YokiUiConfig = {
	theme: "yoki_themes",
	statusline: {
		icon: true,
		directory: true,
		gitBranch: true,
		gitStatus: true,
		context: "auto",
		model: true,
		usage: true,
		extensionStatuses: true,
	},
};

const CONFIG_FILES = ["yoki-ui.json"] as const;

async function readFirstConfigFile(): Promise<{ parsed: unknown; source: string } | undefined> {
	const dir = getAgentDir();
	for (const name of CONFIG_FILES) {
		try {
			const text = await readFile(join(dir, name), "utf8");
			return { parsed: JSON.parse(text), source: name };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") continue;
			return { parsed: null, source: name };
		}
	}
	return undefined;
}

const stringifyValue = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

export async function readConfig(): Promise<{ config: YokiUiConfig; warning?: string }> {
	const loaded = await readFirstConfigFile();
	if (!loaded) return { config: { ...defaults, statusline: { ...defaults.statusline } } };
	if (loaded.parsed === null) {
		return {
			config: { ...defaults, statusline: { ...defaults.statusline } },
			warning: `yoki_ui: invalid ${loaded.source}; using defaults`,
		};
	}

	const parsed = loaded.parsed;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			config: { ...defaults, statusline: { ...defaults.statusline } },
			warning: `yoki_ui: invalid ${loaded.source}; using defaults`,
		};
	}

	const values = parsed as Record<string, unknown>;
	const invalidFields: string[] = [];
	const boolean = (path: string, value: unknown, fallback: boolean) => {
		if (value === undefined) return fallback;
		if (typeof value === "boolean") return value;
		invalidFields.push(`${path}: ${stringifyValue(value)}`);
		return fallback;
	};
	const string = (path: string, value: unknown, fallback: string) => {
		if (value === undefined) return fallback;
		if (typeof value === "string" && value.trim()) return value.trim();
		invalidFields.push(`${path}: ${stringifyValue(value)}`);
		return fallback;
	};

	const statusline =
		values.statusline === undefined
			? {}
			: values.statusline && typeof values.statusline === "object" && !Array.isArray(values.statusline)
				? (values.statusline as Record<string, unknown>)
				: ((invalidFields.push(`statusline: ${stringifyValue(values.statusline)}`)), {});

	const statuslineDefaults = defaults.statusline;
	const context = statusline.context;
	if (context !== undefined && context !== true && context !== false && context !== "auto") {
		invalidFields.push(`statusline.context: ${stringifyValue(context)}`);
	}

	const config: YokiUiConfig = {
		theme: string("theme", values.theme, defaults.theme),
		statusline: {
			icon: boolean("statusline.icon", statusline.icon, statuslineDefaults.icon),
			directory: boolean("statusline.directory", statusline.directory, statuslineDefaults.directory),
			gitBranch: boolean("statusline.gitBranch", statusline.gitBranch, statuslineDefaults.gitBranch),
			gitStatus: boolean("statusline.gitStatus", statusline.gitStatus, statuslineDefaults.gitStatus),
			context:
				context === true || context === false || context === "auto"
					? context
					: statuslineDefaults.context,
			model: boolean("statusline.model", statusline.model, statuslineDefaults.model),
			usage: boolean("statusline.usage", statusline.usage, statuslineDefaults.usage),
			extensionStatuses: boolean(
				"statusline.extensionStatuses",
				statusline.extensionStatuses,
				statuslineDefaults.extensionStatuses,
			),
		},
	};

	const warning =
		invalidFields.length > 0
			? `yoki_ui: invalid ${loaded.source} fields (${invalidFields.join(", ")}); using defaults for those fields`
			: undefined;
	return { config, warning };
}

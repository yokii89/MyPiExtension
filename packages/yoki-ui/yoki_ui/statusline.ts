import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import type { StatuslineConfig } from "./config.ts";
import { piBadge } from "./style.ts";

const piIcon = piBadge();

const PLAN_BRIDGE_SYMBOL = Symbol.for("@yoki/yoki-plan:bridge");

type PlanBridgeLike = {
	isLoaded?: () => boolean;
	getMode?: () => "edit" | "plan";
};

/** "◇ plan" while the soft yoki-plan bridge reports plan mode; empty otherwise. */
export const getPlanBadge = (): string => {
	const bridge = (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL] as
		| PlanBridgeLike
		| undefined;
	if (!bridge || typeof bridge.isLoaded !== "function" || !bridge.isLoaded()) return "";
	if (typeof bridge.getMode !== "function" || bridge.getMode() !== "plan") return "";
	return "◇ plan";
};

const GIT_POLL_MS = 15_000;

const formatTokens = (tokens: number) => {
	if (tokens < 1000) return tokens.toString();
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokens / 1_000_000)}M`;
};

const emptyGitStatus = () => ({
	conflicts: 0,
	untracked: 0,
	modified: 0,
	renamed: 0,
	deleted: 0,
	staged: 0,
	stashed: 0,
	ahead: 0,
	behind: 0,
});

export const parseGitStatus = (output: string) => {
	const status = emptyGitStatus();

	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+) -(\d+)/);
			status.ahead = Number(match?.[1] ?? 0);
			status.behind = Number(match?.[2] ?? 0);
		} else if (line.startsWith("# stash ")) {
			status.stashed = Number(line.slice(8));
		} else if (line.startsWith("? ")) {
			status.untracked++;
		} else if (line.startsWith("u ")) {
			status.conflicts++;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const [index = ".", workingTree = "."] = line.split(" ")[1] ?? "..";
			if (index !== ".") status.staged++;
			if (index === "R" || workingTree === "R") status.renamed++;
			else if (index === "D" || workingTree === "D") status.deleted++;
			else if (workingTree !== ".") status.modified++;
		}
	}

	return status;
};

export type StatuslineRuntime = {
	applyFooter: (ctx: ExtensionContext, config: StatuslineConfig) => void;
	registerHooks: () => void;
};

type CachedSessionStats = {
	usageText: string;
	contextText: string;
	contextPercent: number;
};

/** Shared statusline controller (footer + git refresh hooks). */
export function createStatuslineRuntime(pi: ExtensionAPI): StatuslineRuntime {
	let gitStatus = emptyGitStatus();
	let gitRoot: string | undefined;
	let requestRender: (() => void) | undefined;
	let gitInFlight = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pollCwd: string | undefined;

	// Session stats (usage + context) are O(session size). Recompute only when
	// the agent finishes work — never on every keystroke render.
	let sessionStatsDirty = true;
	let cachedSessionStats: CachedSessionStats = {
		usageText: "",
		contextText: "?%/?",
		contextPercent: 0,
	};

	const markSessionStatsDirty = () => {
		sessionStatsDirty = true;
	};

	const refreshSessionStats = (ctx: ExtensionContext, config: StatuslineConfig) => {
		if (!sessionStatsDirty) return;
		sessionStatsDirty = false;

		let usageText = "";
		if (config.usage) {
			let input = 0;
			let output = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const entryUsage = entry.message.usage;
				input += entryUsage.input;
				output += entryUsage.output;
			}
			usageText = [input && `↑${formatTokens(input)}`, output && `↓${formatTokens(output)}`]
				.filter(Boolean)
				.join(" ");
		}

		// context===true always shows; "auto" needs percent for the >75% gate.
		const needsContext = config.context === true || config.context === "auto";
		let contextText = "?%/?";
		let contextPercent = 0;
		if (needsContext) {
			const usage = ctx.getContextUsage();
			contextPercent = usage?.percent ?? 0;
			contextText = usage
				? `${usage.percent?.toFixed(1) ?? "?"}%/${formatTokens(usage.contextWindow)}`
				: "?%/?";
		}

		cachedSessionStats = { usageText, contextText, contextPercent };
	};

	const refreshGitStatus = async (cwd: string) => {
		if (gitInFlight) return;
		gitInFlight = true;
		try {
			const result = await pi.exec(
				"git",
				["status", "--porcelain=v2", "--branch", "--show-stash"],
				{ cwd, timeout: 1000 },
			);
			if (result.code !== 0) return;
			const next = parseGitStatus(result.stdout);
			if (JSON.stringify(next) === JSON.stringify(gitStatus)) return;
			gitStatus = next;
			requestRender?.();
		} finally {
			gitInFlight = false;
		}
	};

	// Poll while a footer is registered so edits made outside pi (another
	// editor, a terminal) still reach the statusline. requestRender only fires
	// when parsed counts actually changed.
	const startGitPoll = (cwd: string) => {
		pollCwd = cwd;
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			if (!pollCwd) return;
			void refreshGitStatus(pollCwd);
		}, GIT_POLL_MS);
		pollTimer.unref?.();
	};

	const stopGitPoll = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};

	let hooksRegistered = false;
	const registerHooks = () => {
		if (hooksRegistered) return;
		hooksRegistered = true;

		// Usage/context only change after the agent runs, not while the user types.
		pi.on("agent_end", () => markSessionStatsDirty());
		pi.on("turn_end", () => markSessionStatsDirty());

		pi.on("tool_execution_end", async (_event, ctx) => {
			await refreshGitStatus(ctx.cwd);
		});

		// Pick up external edits right before each agent/turn run, too.
		pi.on("agent_start", (_event, ctx) => {
			void refreshGitStatus(ctx.cwd);
		});
		pi.on("turn_start", (_event, ctx) => {
			void refreshGitStatus(ctx.cwd);
		});

		pi.on("session_shutdown", () => {
			stopGitPoll();
		});

		pi.on("user_bash", (_event, ctx) => {
			const local = createLocalBashOperations();
			return {
				operations: {
					async exec(command, cwd, options) {
						const result = await local.exec(command, cwd, options);
						await refreshGitStatus(ctx.cwd);
						return result;
					},
				},
			};
		});
	};

	const applyFooter = (ctx: ExtensionContext, config: StatuslineConfig) => {
		// New look / session: recompute once on next render.
		markSessionStatsDirty();
		startGitPoll(ctx.cwd);

		void (async () => {
			gitRoot = await pi
				.exec("git", ["rev-parse", "--show-toplevel"], {
					cwd: ctx.cwd,
					timeout: 1000,
				})
				.then((result) => (result.code === 0 ? result.stdout.trim() : undefined))
				.catch(() => undefined);
			await refreshGitStatus(ctx.cwd);
		})();

		ctx.ui.setFooter((tui, theme, footerData) => ({
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			invalidate() {
				// Session stats use their own dirty flag; git/branch read live.
				markSessionStatsDirty();
			},
			render(width: number): string[] {
				requestRender = () => tui.requestRender();
				refreshSessionStats(ctx, config);

				const separator = theme.fg("border", "  ");
				const branch = footerData.getGitBranch();
				const extensionStatuses = config.extensionStatuses
					? Array.from(footerData.getExtensionStatuses().values())
					: [];
				const gitStatusText = [
					gitStatus.conflicts && theme.fg("error", `!${gitStatus.conflicts}`),
					gitStatus.untracked && theme.fg("dim", `?${gitStatus.untracked}`),
					gitStatus.stashed && theme.fg("syntaxType", `≡${gitStatus.stashed}`),
					gitStatus.modified && theme.fg("warning", `~${gitStatus.modified}`),
					gitStatus.renamed && theme.fg("syntaxOperator", `→${gitStatus.renamed}`),
					gitStatus.deleted && theme.fg("error", `×${gitStatus.deleted}`),
					gitStatus.staged && theme.fg("success", `+${gitStatus.staged}`),
					gitStatus.ahead && theme.fg("syntaxOperator", `↑${gitStatus.ahead}`),
					gitStatus.behind && theme.fg("customMessageLabel", `↓${gitStatus.behind}`),
				]
					.filter(Boolean)
					.join(" ");
				const left = [
					config.icon && piIcon,
					config.directory &&
						theme.fg(
							"accent",
							`${basename(gitRoot ?? ctx.cwd)}`,
						),
					config.gitBranch &&
						branch &&
						theme.fg("customMessageLabel", `⎇ ${branch}`),
					config.gitStatus && gitStatusText,
				]
					.filter(Boolean)
					.join(separator);

				const model = ctx.model?.id ?? "no model";
				const { usageText, contextText, contextPercent } = cachedSessionStats;

				const showContext =
					config.context === true ||
					(config.context === "auto" && (config.usage || contextPercent > 75));

				const planBadge = getPlanBadge();
				const right = [
					usageText && theme.fg("dim", usageText),
					showContext && theme.fg("muted", contextText),
					planBadge && theme.fg("accent", planBadge),
					config.model &&
						theme.fg(
							"dim",
							ctx.model?.reasoning
								? `${model} • ${pi.getThinkingLevel()}`
								: model,
						),
				]
					.filter(Boolean)
					.join(separator);

				const statusLine = truncateToWidth(extensionStatuses.join(separator), width);

				if (!right) {
					return [truncateToWidth(left, width), statusLine].filter(Boolean);
				}

				if (visibleWidth(right) >= width) {
					return [truncateToWidth(right, width), statusLine].filter(Boolean);
				}

				const shortLeft = truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 1), "…");
				const padding = " ".repeat(Math.max(0, width - visibleWidth(shortLeft) - visibleWidth(right)));
				return [shortLeft + padding + right, statusLine].filter(Boolean);
			},
		}));
	};

	return {
		applyFooter,
		registerHooks,
	};
}

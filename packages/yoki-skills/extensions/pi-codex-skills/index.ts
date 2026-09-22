import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BUNDLED_SKILLS, doctor } from "./catalog.ts";
import { ManagedSkillInstaller } from "./installer.ts";
import { createPlanPanel, type PlanResult } from "./skills-plan-panel.ts";
import { createSkillsPanel, type PanelResult } from "./skills-panel.ts";
import type { SkillCommand } from "./types.ts";

const packageRoot = resolvePackageRoot();
const extensionVersion = "0.1.0";

function resolvePackageRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function loadedSkills(pi: ExtensionAPI): SkillCommand[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name,
			description: command.description,
			path: command.sourceInfo.path,
			sourceInfo: {
				source: command.sourceInfo.source,
				scope: command.sourceInfo.scope,
				origin: command.sourceInfo.origin,
			},
		}));
}

export default function register(pi: ExtensionAPI): void {
	const installer = new ManagedSkillInstaller({ packageRoot, agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), extensionVersion });
	pi.registerCommand("skills", {
		description: "Browse and manage Pi-adapted Codex skills",
		getArgumentCompletions(prefix): AutocompleteItem[] | null {
			const values = ["install", "update", "repair", "uninstall", "doctor"];
			const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [action, name] = args.trim().split(/\s+/, 2);
			const commands = loadedSkills(pi);
			if (action === "doctor") {
				ctx.ui.notify(formatDoctor(doctor(installer.readManifest(), commands)), "info");
				return;
			}
			if (action === "install" || action === "update" || action === "repair" || action === "uninstall") {
				const skill = name || BUNDLED_SKILLS[0]?.name;
				if (!skill) throw new Error("No bundled skill is available.");
				const plan = installer.plan(action, skill, commands);
				const accepted = await confirmPlan(ctx, plan);
				if (!accepted) return;
				await installer.apply(plan);
				await reloadAfterWrite(ctx, installer, plan.skill, action);
				// Pi invalidates this extension context after reload. Do not inspect commands or write a
				// manifest from this stale handler; the next /skills doctor reads the fresh command list.
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/skills panel requires TUI mode; use /skills doctor or a write subcommand.", "warning");
				return;
			}
			const manifest = installer.readManifest();
			const result = await ctx.ui.custom<PanelResult>((tui, theme, keys, done) => createSkillsPanel(tui, theme, keys, commands, doctor(manifest, commands), manifest.skills, BUNDLED_SKILLS, done, ctx.signal));
			if (result.kind === "prefill") ctx.ui.setEditorText(result.command);
			if (result.kind === "manage") {
				const plan = installer.plan(result.operation, result.skill, loadedSkills(pi));
				if (!plan.canApply) {
					ctx.ui.notify(formatPlan(plan), "warning");
					return;
				}
				const accepted = await confirmPlan(ctx, plan);
				if (!accepted) return;
				await installer.apply(plan);
				await reloadAfterWrite(ctx, installer, plan.skill, result.operation);
			}
		},
	});
}

async function confirmPlan(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	plan: ReturnType<ManagedSkillInstaller["plan"]>,
): Promise<boolean> {
	if (ctx.mode !== "tui") return await ctx.ui.confirm("Pi Skills plan", formatPlan(plan));
	const result = await ctx.ui.custom<PlanResult>((tui, theme, keys, done) => createPlanPanel(tui, theme, keys, plan, done, ctx.signal));
	return result.kind === "confirmed";
}

async function reloadAfterWrite(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	installer: ManagedSkillInstaller,
	skill: string,
	operation: "install" | "update" | "repair" | "uninstall",
): Promise<void> {
	try {
		await ctx.reload();
		// Pi invalidates this extension context after a successful reload. Do not use the
		// stale context to inspect commands or write a loader result; /skills doctor in the
		// new session remains the authoritative post-reload check.
	} catch (error) {
		await installer.recordLoaderResult(skill, "reload-failed");
		const message = error instanceof Error ? error.message : "Unknown reload failure";
		ctx.ui.notify(`Pi Skills ${operation} completed, but reload failed: ${message}. Restart Pi, then run /skills doctor.`, "warning");
	}
}

function formatDoctor(items: ReturnType<typeof doctor>): string {
	return items.length === 0 ? "No Pi Skills diagnostics." : items.map((item) => `[${item.severity}] ${item.message} Next: ${item.nextStep}`).join("\n");
}

function formatPlan(plan: { operation: string; skill: string; target: string; files: { relativePath: string }[]; diagnostics: { severity: string; message: string }[]; canApply: boolean }): string {
	const diagnostics = plan.diagnostics.map((item) => `[${item.severity}] ${item.message}`).join("\n") || "No blocking diagnostics.";
	return `${plan.operation} ${plan.skill}\nTarget: ${plan.target}\nFiles: ${plan.files.map((file) => file.relativePath).join(", ")}\n${diagnostics}\n\nApply this plan?`;
}

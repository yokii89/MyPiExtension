import { addWrappedWithPrefix, type PanelTheme, panelRule, panelTitle, truncateVisible } from "./panel-style.ts";
import type { PanelKeybindings, PanelTui } from "./skills-panel.ts";
import type { InstallPlan } from "./types.ts";

export type PlanResult = { kind: "confirmed" } | { kind: "cancelled" };
type PlanState = "preview" | "confirm";

export function createPlanPanel(
	tui: PanelTui,
	theme: PanelTheme,
	keybindings: PanelKeybindings,
	plan: InstallPlan,
	done: (result: PlanResult) => void,
	signal?: AbortSignal,
): { render(width: number): string[]; invalidate(): void; handleInput(data: string): void; dispose(): void } {
	let state: PlanState = "preview";
	let finished = false;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const finish = (result: PlanResult) => {
		if (finished) return;
		finished = true;
		done(result);
	};
	const onAbort = () => finish({ kind: "cancelled" });
	signal?.addEventListener("abort", onAbort);
	const refresh = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
		tui.requestRender();
	};

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const renderWidth = Math.max(1, width);
			const title = state === "preview" ? "Pi Skills · Review plan" : "Pi Skills · Confirm change";
			const lines = [panelRule(theme, renderWidth), panelTitle(theme, title, renderWidth), ""];
			addWrappedWithPrefix(lines, " ", theme.bold(theme.fg("text", `${plan.operation} ${plan.skill}`)), renderWidth);
			addWrappedWithPrefix(lines, " ", theme.fg("dim", `Target: ${plan.target}`), renderWidth);
			addWrappedWithPrefix(lines, " ", theme.fg("dim", `Files: ${plan.files.map((file) => file.relativePath).join(", ") || "none"}`), renderWidth);
			for (const diagnostic of plan.diagnostics) {
				const color = diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "dim";
				addWrappedWithPrefix(lines, " ", theme.fg(color, `[${diagnostic.severity}] ${diagnostic.message}`), renderWidth);
			}
			if (!plan.canApply) addWrappedWithPrefix(lines, " ", theme.fg("warning", "This plan cannot be applied. Resolve the diagnostics before trying again."), renderWidth);
			if (state === "confirm") addWrappedWithPrefix(lines, " ", theme.fg("warning", "Apply this exact plan?"), renderWidth);
			const confirm = keybindings.getKeys("tui.select.confirm").join("/");
			const cancel = keybindings.getKeys("tui.select.cancel").join("/");
			const hint = !plan.canApply ? ` ${cancel} close` : state === "preview" ? ` ${confirm} continue · ${cancel} cancel` : ` ${confirm} apply · ${cancel} cancel`;
			lines.push("", theme.fg("dim", truncateVisible(hint, renderWidth)), panelRule(theme, renderWidth));
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		handleInput(data: string): void {
			if (finished) return;
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish({ kind: "cancelled" });
				return;
			}
			if (!plan.canApply || !keybindings.matches(data, "tui.select.confirm")) return;
			if (state === "preview") {
				state = "confirm";
				refresh();
				return;
			}
			finish({ kind: "confirmed" });
		},
		dispose(): void {
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

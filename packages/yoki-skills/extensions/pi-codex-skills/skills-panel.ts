import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { addWrappedWithPrefix, panelRule, panelTitle, selectedRow, truncateVisible } from "./panel-style.ts";
import type { BundledSkill, DoctorDiagnostic, InstallPlan, ManagedSkill, SkillCommand } from "./types.ts";

export type PanelResult = { kind: "prefill"; command: string } | { kind: "manage"; skill: string; operation: InstallPlan["operation"] } | { kind: "cancelled" };

type PanelPage = "home" | "browse" | "details" | "manage" | "manage-operation" | "doctor";
export interface PanelKeybindings {
	matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
	getKeys(binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string[];
}

const operations: InstallPlan["operation"][] = ["install", "update", "repair", "uninstall"];

function pageTitle(page: PanelPage): string {
	return page === "home" ? "Pi Skills" : page === "browse" ? "Pi Skills · Browse" : page === "details" ? "Pi Skills · Details" : page === "manage" ? "Pi Skills · Manage" : page === "manage-operation" ? "Pi Skills · Choose operation" : "Pi Skills · Doctor";
}

export function createSkillsPanel(
	tui: TUI,
	theme: Theme,
	keybindings: PanelKeybindings,
	commands: SkillCommand[],
	diagnostics: DoctorDiagnostic[],
	managedSkills: ManagedSkill[],
	availableSkills: readonly BundledSkill[],
	done: (result: PanelResult) => void,
	signal?: AbortSignal,
): { render(width: number): string[]; invalidate(): void; handleInput(data: string): void; dispose(): void } {
	let page: PanelPage = "home";
	let focus = 0;
	let search = "";
	let detail: SkillCommand | undefined;
	let manageSkill: BundledSkill | undefined;
	let finished = false;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const finish = (result: PanelResult) => {
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
	const matchingCommands = () => commands.filter((command) => command.name.toLowerCase().includes(search.toLowerCase()) || (command.description ?? "").toLowerCase().includes(search.toLowerCase()));
	const itemCount = () => {
		if (page === "home") return 3;
		if (page === "browse") return Math.max(1, matchingCommands().length);
		if (page === "manage") return Math.max(1, availableSkills.length);
		if (page === "manage-operation") return operations.length;
		return Math.max(1, diagnostics.length);
	};
	const addOption = (lines: string[], selected: boolean, label: string, description: string, width: number) => {
		lines.push(selectedRow(theme, selected, label, width));
		addWrappedWithPrefix(lines, "    ", theme.fg("dim", description), width);
	};

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const renderWidth = Math.max(1, width);
			const lines = [panelRule(theme, renderWidth), panelTitle(theme, pageTitle(page), renderWidth), ""];
			if (page === "home") {
				addOption(lines, focus === 0, "Browse loaded skills", "Search and prefill Pi /skill:<name>", renderWidth);
				addOption(lines, focus === 1, "Manage managed skills", "Install, update, repair, or uninstall bundled skills", renderWidth);
				addOption(lines, focus === 2, "Doctor", "Inspect discovery, collisions, and compatibility", renderWidth);
			} else if (page === "browse") {
				addWrappedWithPrefix(lines, " ", theme.fg("dim", `Search: ${search || "all loaded skills"}`), renderWidth);
				const matching = matchingCommands();
				if (matching.length === 0) addWrappedWithPrefix(lines, " ", theme.fg("warning", "No matching Pi skill commands are currently loaded."), renderWidth);
				for (let index = 0; index < matching.length; index++) {
					const command = matching[index];
					if (!command) continue;
					const selected = index === focus;
					lines.push(selectedRow(theme, selected, command.name, renderWidth));
					addWrappedWithPrefix(lines, "    ", theme.fg("dim", command.description ?? command.path), renderWidth);
					if (selected) addWrappedWithPrefix(lines, "    ", theme.fg("dim", `Path: ${command.path}`), renderWidth);
				}
			} else if (page === "details" && detail) {
				const selectedDetail = detail;
				const managed = managedSkills.find((skill) => skill.canonicalTarget.replaceAll("\\", "/") === selectedDetail.path.replace(/[/\\]SKILL\.md$/i, "").replaceAll("\\", "/"));
				addWrappedWithPrefix(lines, " ", theme.bold(theme.fg("text", selectedDetail.name)), renderWidth);
				addWrappedWithPrefix(lines, " ", theme.fg("text", selectedDetail.description ?? "No description supplied by Pi."), renderWidth);
				addWrappedWithPrefix(lines, " ", theme.fg("dim", `Path: ${selectedDetail.path}`), renderWidth);
				if (selectedDetail.sourceInfo) addWrappedWithPrefix(lines, " ", theme.fg("dim", `Pi source: ${selectedDetail.sourceInfo.source} · scope: ${selectedDetail.sourceInfo.scope} · origin: ${selectedDetail.sourceInfo.origin}`), renderWidth);
				const state = managed ? `Managed: ${managed.state ?? "installed"} · loader: ${managed.lastLoaderResult}` : "Not managed by this extension.";
				addWrappedWithPrefix(lines, " ", theme.fg(managed ? "success" : "muted", state), renderWidth);
			} else if (page === "manage") {
				addWrappedWithPrefix(lines, " ", theme.fg("dim", "Select a bundled Pi-adapted skill to manage."), renderWidth);
				for (let index = 0; index < availableSkills.length; index++) {
					const skill = availableSkills[index];
					if (!skill) continue;
					const managed = managedSkills.find((entry) => entry.name === skill.name);
					const state = managed?.state ?? "not installed";
					lines.push(selectedRow(theme, index === focus, skill.name, renderWidth));
					addWrappedWithPrefix(lines, "    ", theme.fg(managed ? "success" : "muted", state), renderWidth);
				}
			} else if (page === "manage-operation" && manageSkill) {
				const selectedManageSkill = manageSkill;
				const managed = managedSkills.find((entry) => entry.name === selectedManageSkill.name);
				addWrappedWithPrefix(lines, " ", theme.fg("dim", `${selectedManageSkill.name}: ${managed?.state ?? "not installed"}`), renderWidth);
				for (let index = 0; index < operations.length; index++) {
					const operation = operations[index];
					if (!operation) continue;
					addOption(lines, index === focus, operation, `${operation} ${selectedManageSkill.name}`, renderWidth);
				}
			} else {
				if (diagnostics.length === 0) addWrappedWithPrefix(lines, " ", theme.fg("success", "No doctor diagnostics."), renderWidth);
				for (let index = 0; index < diagnostics.length; index++) {
					const diagnostic = diagnostics[index];
					if (!diagnostic) continue;
					const selected = index === focus;
					const color = diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "muted";
					lines.push(selectedRow(theme, selected, `[${diagnostic.severity}] ${diagnostic.message}`, renderWidth));
					if (selected) {
						addWrappedWithPrefix(lines, "    ", theme.fg("dim", diagnostic.nextStep), renderWidth);
						if (diagnostic.path) addWrappedWithPrefix(lines, "    ", theme.fg(color, `Path: ${diagnostic.path}`), renderWidth);
					}
				}
			}
			const upDown = `${keybindings.getKeys("tui.select.up").join("/")}/${keybindings.getKeys("tui.select.down").join("/")}`;
			const confirm = keybindings.getKeys("tui.select.confirm").join("/");
			const cancel = keybindings.getKeys("tui.select.cancel").join("/");
			const hint = page === "home" ? ` ${upDown} focus · ${confirm} open · ${cancel} close` : page === "browse" ? ` Type search · ${upDown} focus · ${confirm} details · ${cancel} back` : page === "details" ? ` ${confirm} prefill command · ${cancel} back` : page === "manage" ? ` ${upDown} focus · ${confirm} continue · ${cancel} back` : page === "manage-operation" ? ` ${upDown} focus · ${confirm} review plan · ${cancel} back` : ` ${upDown} focus · ${cancel} back`;
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
				if (page === "browse" && search) {
					search = "";
					focus = 0;
					refresh();
					return;
				}
				if (page !== "home") {
					page = page === "details" ? "browse" : page === "manage-operation" ? "manage" : "home";
					focus = 0;
					refresh();
				} else finish({ kind: "cancelled" });
				return;
			}
			if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				const delta = keybindings.matches(data, "tui.select.up") ? -1 : 1;
				focus = (focus + delta + itemCount()) % itemCount();
				refresh();
				return;
			}
			if (page === "browse" && matchesKey(data, Key.backspace)) {
				search = search.slice(0, -1);
				focus = 0;
				refresh();
				return;
			}
			if (page === "browse" && /^[\p{L}\p{N} -]$/u.test(data)) {
				search += data;
				focus = 0;
				refresh();
				return;
			}
			if (!keybindings.matches(data, "tui.select.confirm")) return;
			if (page === "home") {
				page = focus === 0 ? "browse" : focus === 1 ? "manage" : "doctor";
				focus = 0;
				refresh();
				return;
			}
			if (page === "browse") {
				const command = matchingCommands()[focus];
				if (!command) return;
				detail = command;
				page = "details";
				focus = 0;
				refresh();
				return;
			}
			if (page === "details") {
				if (detail) finish({ kind: "prefill", command: `/${detail.name}` });
				return;
			}
			if (page === "manage") {
				const skill = availableSkills[focus];
				if (!skill) return;
				manageSkill = skill;
				page = "manage-operation";
				focus = 0;
				refresh();
				return;
			}
			if (page === "manage-operation" && manageSkill) finish({ kind: "manage", skill: manageSkill.name, operation: operations[focus] ?? "install" });
		},
		dispose(): void {
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

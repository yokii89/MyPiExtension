declare module "@earendil-works/pi-tui" {
	export interface AutocompleteItem {
		value: string;
		label: string;
		description?: string;
	}
	export interface TUI { requestRender(): void; }
	export const Key: { escape: string; enter: string; up: string; down: string; backspace: string };
	export function matchesKey(data: string, key: string): boolean;
	export function visibleWidth(text: string): number;
	export function wrapTextWithAnsi(text: string, width: number): string[];
}

declare module "@earendil-works/pi-coding-agent" {
	import type { AutocompleteItem, TUI } from "@earendil-works/pi-tui";
	export interface Theme {
		fg(color: "accent" | "text" | "muted" | "dim" | "success" | "warning" | "error", text: string): string;
		bg(color: "selectedBg", text: string): string;
		bold(text: string): string;
	}
	export interface ExtensionContext {
		mode: "tui" | "rpc" | "json" | "print";
		signal: AbortSignal | undefined;
		ui: {
			confirm(title: string, message: string): Promise<boolean>;
			notify(message: string, type?: "info" | "warning" | "error"): void;
			setEditorText(text: string): void;
			custom<T>(factory: (tui: TUI, theme: Theme, keybindings: { matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean; getKeys(binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string[] }, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void; dispose(): void }): Promise<T>;
		};
	}
	export interface ExtensionCommandContext extends ExtensionContext { reload(): Promise<void>; }
	export interface SlashCommandInfo { name: string; description?: string; source: "extension" | "prompt" | "skill"; sourceInfo: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level" }; }
	export interface ExtensionAPI {
		getCommands(): SlashCommandInfo[];
		registerCommand(name: string, options: { description?: string; getArgumentCompletions?(prefix: string): AutocompleteItem[] | null; handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void }): void;
	}
}

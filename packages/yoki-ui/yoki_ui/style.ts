/**
 * Shared TUI style tokens — the single source of truth for glyphs, status
 * colors, and rules across all yoki Pi extensions. Import from `yoki_ui/style`.
 *
 * Rules of the road (see packages/yoki-ui/STYLE.md for the full spec):
 * - Never hardcode SGR color codes (`\x1b[31m`); always go through the theme's
 *   semantic color names. The only sanctioned exception is `BRAND_RGB` below.
 * - Never redeclare pointer/status glyphs locally; import them from here.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** Active/selected row pointer. Always paired with a trailing space (width 2); inactive rows use `POINTER_INACTIVE`. */
export const POINTER = "❯ ";
/** Blank counterpart of `POINTER`, keeping inactive rows aligned. */
export const POINTER_INACTIVE = "  ";

export const GLYPH_SUCCESS = "✓";
export const GLYPH_ERROR = "✗";
export const GLYPH_WARNING = "⚠";
export const ELLIPSIS = "…";

/** Queued / not started. */
export const GLYPH_PENDING = "○";
/** In progress / active work. */
export const GLYPH_RUNNING = "◐";
/** Terminal state marker for list rows (result echoes use GLYPH_SUCCESS instead). */
export const GLYPH_DONE = "●";
/** Deleted / discarded. */
export const GLYPH_DELETED = "⊘";
/** In-flight activity with no progress fraction to show. */
export const GLYPH_ACTIVITY = "⋯";

/** Spinner frames for inline TUI components (tick ~150ms). */
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

// ---------------------------------------------------------------------------
// Status → glyph/color mapping
// ---------------------------------------------------------------------------

/** Color names are a subset of the theme's semantic palette. */
export type StatusColor = "dim" | "muted" | "warning" | "success" | "error";

/** Queue-style lifecycle (todo lists, task states). */
export const STATUS_GLYPH = {
	pending: GLYPH_PENDING,
	inProgress: GLYPH_RUNNING,
	completed: GLYPH_DONE,
	deleted: GLYPH_DELETED,
} as const;

export const STATUS_COLOR = {
	pending: "dim",
	inProgress: "warning",
	completed: "success",
	deleted: "muted",
} as const satisfies Record<keyof typeof STATUS_GLYPH, StatusColor>;

/** Operation outcome echoes (request results, fetches, checks). */
export const RESULT_GLYPH = {
	success: GLYPH_SUCCESS,
	error: GLYPH_ERROR,
	running: GLYPH_ACTIVITY,
	aborted: GLYPH_PENDING,
} as const;

export const RESULT_COLOR = {
	success: "success",
	error: "error",
	running: "warning",
	aborted: "muted",
} as const satisfies Record<keyof typeof RESULT_GLYPH, StatusColor>;

// ---------------------------------------------------------------------------
// Rules / dividers
// ---------------------------------------------------------------------------

/** Accent-colored horizontal rule (`───`), the canonical section divider. */
export function rule(theme: Pick<Theme, "fg">, width: number): string {
	return theme.fg("accent", "─".repeat(Math.max(1, width)));
}

/**
 * Accent-colored rule with an embedded label: `─── Label ──────…` padded to
 * `width` columns (minimum `─── Label`).
 */
export function ruleWithLabel(theme: Pick<Theme, "fg">, width: number, label: string): string {
	const prefix = `─── ${label} `;
	const fill = Math.max(0, width - prefix.length);
	return theme.fg("accent", `${prefix}${"─".repeat(fill)}`);
}

// ---------------------------------------------------------------------------
// ANSI utilities
// ---------------------------------------------------------------------------

/** Strip SGR, OSC8, and APC sequences so plain text can be inspected/measured. */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[^\x07]*\x07/g, "");
}

// ---------------------------------------------------------------------------
// Brand exception
// ---------------------------------------------------------------------------

/**
 * The only sanctioned raw-color exceptions: fixed brand accents that must stay
 * on-brand regardless of the active theme.
 */
export const BRAND_RGB = "215;119;87";

/** Statusline "π" badge: dark foreground on mauve background, theme-independent. */
export const BADGE_FG_RGB = "16;19;16";
export const BADGE_BG_RGB = "135;111;127";
export const piBadge = () => `\x1b[38;2;${BADGE_FG_RGB};48;2;${BADGE_BG_RGB}m π \x1b[0m`;

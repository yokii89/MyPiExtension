import type { Component } from "@earendil-works/pi-tui";

/**
 * Generic prop-driven component contract. Every renderable owns its own `P` shape;
 * the adapter computes `P` from canonical state via per-component selectors and
 * pushes it via `setProps`. `focused: boolean` is a field on `P` only where the
 * component needs it.
 */
export interface StatefulView<P> extends Component {
	setProps(props: P): void;
}

/**
 * Discriminated focus union — encodes the two-cell focus invariant
 * (submit-tab, options). The dispatcher cascade (`key-router.ts`) guarantees
 * at most one of them is live; this type makes it explicit so per-component
 * `focused: boolean` flags derive from one equality check against this
 * discriminant rather than parallel boolean reads.
 *
 * Priority order: submit > options. Matches the dispatcher cascade exactly.
 */
export type ActiveView = "options" | "submit";

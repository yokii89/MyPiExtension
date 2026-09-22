/**
 * Production SDK wiring for the Telegram desktop panel
 * Zones: telegram, desktop
 * The only place that reaches `@pidesk/view-sdk` at runtime — and it does so
 * lazily, one call at a time.
 *
 * The SDK ships TypeScript source whose internal relative imports are
 * `.js`-suffixed, so resolving it needs a bundler (pi's extension loader, Vite).
 * A static import here would make `index.ts` unloadable under
 * `node --experimental-strip-types`, which is how this package runs its own
 * suite. Resolving on demand keeps the entrypoint importable, and a failed load
 * is treated exactly like "no Host": soft `null`, TUI path preserved
 * (docs/design/19 §4.5).
 */

import type {
	connectDesktopView,
	DesktopViewClient,
	LiveViewSession,
	openPanel,
	resolveContributionKey,
} from "@pidesk/view-sdk";
import type { TelegramPanelClient, TelegramPanelSdk } from "./desktop-panel.ts";

/** Just the two entry points this adapter needs, typed off the real exports. */
interface ViewSdkSurface {
	connectDesktopView: typeof connectDesktopView;
	openPanel: typeof openPanel;
	resolveContributionKey: typeof resolveContributionKey;
}

async function loadViewSdk(): Promise<ViewSdkSurface | null> {
	try {
		return await import("@pidesk/view-sdk");
	} catch {
		// 解析不了 SDK 源码 = 没有可用的桌面宿主，按无 Host 软失败处理
		return null;
	}
}

/** The real `@pidesk/view-sdk` surface, shaped for `createTelegramPanelRuntime`. */
export function createTelegramPanelSdk(): TelegramPanelSdk {
	return {
		async connect() {
			const sdk = await loadViewSdk();
			const client = sdk?.connectDesktopView() ?? null;
			return client as TelegramPanelClient | null;
		},

		async supportsCapability(client, capability) {
			// hello 缺失（无宿主 / 握手超时）按不支持处理：回落 row 组合，不猜能力
			const hello = await (client as DesktopViewClient).ensureConnected();
			return (hello?.capabilities ?? []).some((entry) => entry === capability);
		},

		async openPanel(client, options) {
			const sdk = await loadViewSdk();
			if (!sdk) return null;
			// Catalog binding（docs/design/19 §10.1）：Host 注入 env 时带上稳定 key
			const contributionKey = sdk.resolveContributionKey?.(options.panelId);
			const session: LiveViewSession | null = await sdk.openPanel(
				client as Parameters<typeof openPanel>[0],
				{
					panelId: options.panelId,
					title: options.title,
					contributionKey,
					// 投影层产出的是协议合法树；SDK 的类型由 view-sdk 自己保证
					root: options.root as Parameters<typeof openPanel>[1]["root"],
					actions: options.actions as Parameters<typeof openPanel>[1]["actions"],
					onEvent: (event) => {
						options.onEvent({
							type: event.type,
							actionId: event.type === "action" ? event.actionId : undefined,
						});
						// 动作事件不关闭面板：kind 已声明为 "event"，Host 不会 close
					},
				},
			);
			if (!session) return null;
			// LiveViewSession.update 收 ViewNode | ViewUpdatePayload；投影层给的是
			// { root, actions }，形状一致，此处只做窄化。
			return {
				update: ({ root, actions }) =>
					session.update({ root, actions } as Parameters<typeof session.update>[0]),
				close: () => session.close(),
				closed: session.closed as Promise<{ reason?: string } | null>,
			};
		},
	};
}

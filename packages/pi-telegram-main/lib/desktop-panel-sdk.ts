/**
 * Production SDK wiring for the Telegram desktop panel
 * Zones: telegram, desktop
 * The only place that reaches `@pidesk/view-sdk` at runtime — and it does so
 * lazily, one call at a time.
 *
 * Why lazy: the package is **not on a registry** yet (docs/design/20 O6), so an
 * install of `@llblab/pi-telegram` elsewhere has a dependency that cannot
 * resolve. A failed load is treated exactly like "no Host" — soft `null`, TUI
 * path preserved (docs/design/19 §4.5) — which a static import could not do: it
 * would take the whole bridge down at extension load.
 *
 * Everything the lifecycle needs from the SDK is handed out here (capability
 * gate, frame coalescer, panel session) so no other module in this package
 * imports SDK runtime code, and no other module re-implements what the SDK
 * already decides (准则 §7.1, §9).
 */

import type {
	connectDesktopView,
	createViewFrameScheduler,
	DesktopViewClient,
	LiveViewSession,
	openPanel,
	resolveContributionKey,
	supportsTable,
} from "@pidesk/view-sdk";
import type { TelegramPanelClient, TelegramPanelSdk, TelegramPanelSession } from "./desktop-panel.ts";

/** Just the entry points this adapter needs, typed off the real exports. */
interface ViewSdkSurface {
	connectDesktopView: typeof connectDesktopView;
	openPanel: typeof openPanel;
	resolveContributionKey: typeof resolveContributionKey;
	supportsTable: typeof supportsTable;
	createViewFrameScheduler: typeof createViewFrameScheduler;
}

async function loadViewSdk(): Promise<ViewSdkSurface | null> {
	try {
		return await import("@pidesk/view-sdk");
	} catch {
		// 解析不了 SDK（未发布 / 未构建）= 没有可用的桌面宿主，按无 Host 软失败处理
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

		async supportsTable(client) {
			const sdk = await loadViewSdk();
			if (!sdk) return false;
			const target = client as DesktopViewClient;
			// hello 落地后才能判定；缺失（无宿主 / 握手超时）按不支持处理，不猜能力
			await target.ensureConnected();
			return sdk.supportsTable(target);
		},

		async openPanel(client, options) {
			const sdk = await loadViewSdk();
			if (!sdk) return null;
			// Catalog binding（docs/design/19 §10.1）：Host 注入 env 时带上稳定 key
			const contributionKey = sdk.resolveContributionKey?.(options.panelId);
			const session: LiveViewSession | null = await sdk.openPanel(client as Parameters<typeof openPanel>[0], {
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
			});
			if (!session) return null;
			// LiveViewSession.update 收 ViewNode | ViewUpdatePayload；投影层给的是
			// { root, actions }，形状一致，此处只做窄化。
			const wrapper: TelegramPanelSession = {
				update: ({ root, actions }) => session.update({ root, actions } as Parameters<typeof session.update>[0]),
				close: () => session.close(),
				closed: session.closed as Promise<{ reason?: string } | null>,
				// 合并窗口是 SDK 的语义（docs/design/20 O4）：扩展只决定何时标脏。
				createFrameScheduler: (schedulerOptions) => sdk.createViewFrameScheduler(schedulerOptions),
			};
			return wrapper;
		},
	};
}

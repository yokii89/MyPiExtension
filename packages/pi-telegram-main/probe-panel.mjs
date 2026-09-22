const { projectTelegramPanel, TELEGRAM_PANEL_ACTIONS } = await import("./lib/desktop-view.ts");
const { createTelegramPanelRuntime } = await import("./lib/desktop-panel.ts");

const state = {
  hasBotToken: true, botUsername: "b", activeProfileName: "default",
  pollingActive: true, pendingDispatch: false, compactionInProgress: false,
  activeToolExecutions: 0, pendingModelSwitch: false, queuedItems: [], recentRuntimeEvents: [],
};
const source = { getStatusState: () => state, listThreads: () => [], listQueuedItems: () => [] };
const seen = [];
const sessions = [];
const sdk = {
  connect: () => ({ dispose(){} }),
  openPanel: async (_c, o) => {
    const s = { updates: [], closed: false,
      update: (p) => { s.updates.push(p); },
      close: () => { s.closed = true; },
      closed: new Promise(()=>{}) };
    s.emit = (e) => o.onEvent(e);
    sessions.push(s);
    return s;
  },
};

const rt = createTelegramPanelRuntime({
  source, sdk, pollIntervalMs: 0,
  actions: { connect: ()=>{seen.push("connect")}, disconnect: ()=>{seen.push("disconnect")}, refresh: ()=>{seen.push("refresh")} },
});

console.log("open ->", await rt.open());
console.log("updates after open:", sessions[0].updates.length, "projected:", rt.stats.projected);

sessions[0].emit({ type:"action", actionId: TELEGRAM_PANEL_ACTIONS.refresh });
sessions[0].emit({ type:"action", actionId: TELEGRAM_PANEL_ACTIONS.disconnect });
await new Promise(r=>setTimeout(r,50));
console.log("seen:", seen);
console.log("updates total:", sessions[0].updates.length);
rt.dispose();

try {
  const m = await import("./lib/desktop-view.ts");
  console.log("desktop-view loaded, exports:", Object.keys(m).length);
} catch (e) { console.log("FAIL desktop-view:", e.message); }
try {
  const m = await import("./lib/desktop-panel.ts");
  console.log("desktop-panel loaded, exports:", Object.keys(m).join(","));
} catch (e) { console.log("FAIL desktop-panel:", e.message); }

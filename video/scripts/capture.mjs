// Capturador por CDP para el Chrome de captura (puerto 9223).
// Uso: node scripts/capture.mjs <url> <salida.png> [scale] [delayMs] [width] [height]
const [url, out, scaleArg, delayArg, wArg, hArg] = process.argv.slice(2);
const scale = Number(scaleArg ?? 2);
const delay = Number(delayArg ?? 4000);
const width = Number(wArg ?? 1600);
const height = Number(hArg ?? 1000);

const tabs = await fetch("http://127.0.0.1:9223/json").then((r) => r.json());
let page = tabs.find((t) => t.type === "page" && t.url.includes("mugar123"));
if (!page) {
  page = await fetch(
    `http://127.0.0.1:9223/json/new?about:blank`,
    { method: "PUT" }
  ).then((r) => r.json());
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: scale,
  mobile: false,
});
// HashRouter: navegar con recarga para que la ruta monte de verdad.
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, delay));
const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out);
process.exit(0);

// Evalúa JS en la página actual del Chrome de captura y/o captura pantalla.
// Uso: node scripts/shot.mjs [--eval 'expr'] [--out fichero.png] [--scale N] [--delay ms] [--key ArrowDown]
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const evalExpr = get("--eval");
const out = get("--out");
const scale = Number(get("--scale") ?? 2);
const delay = Number(get("--delay") ?? 1500);
const key = get("--key");

const tabs = await fetch("http://127.0.0.1:9223/json").then((r) => r.json());
const page = tabs.find((t) => t.type === "page" && t.url.includes("mugar123"));
if (!page) throw new Error("no hay pestaña de PaperTok");

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

if (out) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: scale,
    mobile: false,
  });
}
if (evalExpr) {
  const res = await send("Runtime.evaluate", {
    expression: evalExpr,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log("eval:", JSON.stringify(res.result?.value ?? res.result?.description ?? null)?.slice(0, 2000));
}
if (key) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: key === "ArrowDown" ? 40 : key === "ArrowUp" ? 38 : 0,
    });
  }
}
await new Promise((r) => setTimeout(r, delay));
if (out) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
}
process.exit(0);

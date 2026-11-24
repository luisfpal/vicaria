// Drive the Android app's WebView over its DevTools socket, with plain CDP (Playwright cannot attach to a WebView).
// Setup: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid of io.github.luisfpal.vicaria>
// Usage: node e2e/android/cdp.mjs '<body of an async function run in the page>'  -> prints the JSON it returns
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const ws = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const wait = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); wait.get(m.id)?.(m); };
export const send = (method, params = {}) => new Promise(ok => { const i = ++id; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send("Runtime.evaluate", { expression: `(async () => { ${process.argv[2]} })()`, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value));
ws.close();

// Commonplace on-device server: Pyodide runs the real book_reader package; files persist in IndexedDB (IDBFS at /data).
// Messages in: {id, method, path, headers, body(ArrayBuffer|null)}. Out: {id, status, headers, body(ArrayBuffer)}.
import { loadPyodide } from "./pyodide/pyodide.mjs";

let py, bridge, chain = Promise.resolve(), dirty = false;

const syncfs = populate => new Promise((ok, bad) => py.FS.syncfs(populate, e => e ? bad(e) : ok()));

const ready = (async () => {
  const t0 = performance.now();
  py = await loadPyodide({ indexURL: new URL("./pyodide/", location.href).href, stdout: () => {}, stderr: () => {} });
  py.FS.mkdirTree("/data");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
  await syncfs(true);
  const zip = await (await fetch(new URL("./app.zip", location.href))).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/app" });
  py.runPython("import sys; sys.path.insert(0, '/app')");
  bridge = py.pyimport("cp_bridge");
  postMessage({ ready: true, ms: Math.round(performance.now() - t0) });
})().catch(e => { postMessage({ ready: false, error: String(e) }); throw e; });

async function persist() {
  if (!dirty) return;
  dirty = false;
  await syncfs(false);
}

function run(msg) {
  const body = msg.body ? new Uint8Array(msg.body) : null;
  const out = bridge.handle(msg.method, msg.path, py.toPy(msg.headers || {}), body);
  const [status, headers, data] = out.toJs({ create_proxies: false });
  out.destroy();
  const buf = data.slice().buffer;  // copy out of wasm memory
  return { status, headers: headers.map(h => [h[0], h[1]]), body: buf };
}

onmessage = e => {
  const msg = e.data;
  chain = chain.then(async () => {
    await ready;
    let res;
    try { res = run(msg); }
    catch (err) { res = { status: 500, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode(JSON.stringify({ error: String(err).slice(0, 300) })).buffer }; }
    postMessage({ id: msg.id, ...res }, [res.body]);
    if (msg.method !== "GET" || /[?&]make=1|\/distill|\/offline/.test(msg.path)) dirty = true;
    // background jobs (whole-book distill, AI repair) queued by this request run now, then everything is saved
    if (bridge.pending()) { postMessage({ busy: true }); bridge.run_deferred(); dirty = true; postMessage({ busy: false, changed: true }); }
    await persist();
  }).catch(() => {});
};

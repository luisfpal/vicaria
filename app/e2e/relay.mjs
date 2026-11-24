// A small Nostr relay (NIP-01) for end-to-end tests: stores events (latest per pubkey, kind and "d" tag for kinds
// 30000-39999; not at all for ephemeral 20000-29999), answers REQ with stored matches then EOSE, and passes new events
// to open subscriptions. Signatures are not checked. Can drop or delay traffic to test unreliable relays.
// Usage: import { startRelay } from "./relay.mjs"; const r = await startRelay(47830); ... r.close()
import { WebSocketServer } from "ws";
export async function startRelay(port, opts = {}) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const events = new Map(); const subs = new Set(); let stats = { events: 0, reqs: 0 };
  const dkey = e => `${e.pubkey}:${e.kind}:${e.tags.find(t => t[0] === "d")?.[1] ?? ""}`;
  const match = (e, f) => (!f.ids || f.ids.includes(e.id)) && (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) &&
    (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until) &&
    Object.entries(f).every(([k, v]) => !k.startsWith("#") || e.tags.some(t => t[0] === k.slice(1) && v.includes(t[1])));
  wss.on("connection", ws => {
    const mine = new Map();
    ws.on("message", raw => {
      if (opts.paused) return;
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m[0] === "EVENT") {
        const e = m[1]; stats.events++;
        if (e.kind < 20000 || e.kind >= 30000) events.set(e.kind >= 30000 && e.kind < 40000 ? dkey(e) : e.id, e);
        ws.send(JSON.stringify(["OK", e.id, true, ""]));
        for (const s of subs) if (s.filters.some(f => match(e, f))) s.ws.send(JSON.stringify(["EVENT", s.id, e]));
      } else if (m[0] === "REQ") {
        stats.reqs++;
        const [, id, ...filters] = m; const s = { ws, id, filters }; mine.set(id, s); subs.add(s);
        for (const e of events.values()) if (filters.some(f => match(e, f))) ws.send(JSON.stringify(["EVENT", id, e]));
        ws.send(JSON.stringify(["EOSE", id]));
      } else if (m[0] === "CLOSE") { const s = mine.get(m[1]); if (s) { subs.delete(s); mine.delete(m[1]); } }
    });
    ws.on("close", () => { for (const s of mine.values()) subs.delete(s); });
  });
  await new Promise(ok => wss.on("listening", ok));
  return { url: `ws://127.0.0.1:${port}`, close: () => new Promise(ok => { for (const c of wss.clients) c.terminate(); wss.close(ok); }), stats: () => stats, stored: () => events.size, opts };
}

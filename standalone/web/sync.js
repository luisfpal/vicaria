// Vicaria sync (internal ids keep the old name "excerpta" so devices paired before the rename stay paired): your devices keep each other up to date with no server of ours.
// Pairing shares a library id and a 256-bit key (QR code or link; the part after # never leaves the device).
// Direct: WebRTC between your devices (Trystero), found through public Nostr relays; the data channel is encrypted.
// Otherwise: the snapshot is gzip-compressed, AES-GCM encrypted with the pairing key, chunked into Nostr events that
// expire after 30 days, and stored on public relays until your other device picks it up. Relays see only ciphertext.
(() => {
  const BASE = window.EXC_BASE || "";
  const RELAYS = ["wss://relay.primal.net", "wss://relay.nostr.net", "wss://offchain.pub", "wss://relay.snort.social", "wss://relay.ditto.pub", "wss://nostr.overmind.lol"];
  const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  const KIND = 30078, CHUNK = 30000, KEEP_DAYS = 30;
  const te = new TextEncoder(), td = new TextDecoder();
  const api = async (p, o) => { const r = await fetch(BASE + p, o); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
  const b64 = { to: u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    from: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)) };
  const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
  const sha = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(parts.join("|"))));
  const pipe = async (u8, T) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new T("gzip"))).arrayBuffer());
  const dev = () => localStorage.dev || "dev-unknown";

  let P = JSON.parse(localStorage.xsync || "null"), K = null, room = null, pool = null, sub = null, peers = {}, onPanel = () => {};
  const stats = { direct: null, relay: null, sent: 0, got: 0, log: [] };
  const note = (s) => { stats.log.unshift(new Date().toLocaleTimeString() + " " + s); stats.log.length = Math.min(stats.log.length, 12); onPanel(); };

  async function keys() {
    const raw = b64.from(P.key);
    return { aes: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
      room: hex(await sha("excerpta-room", P.key)).slice(0, 32), tag: hex(await sha("excerpta-tag", P.key)).slice(0, 24),
      nsk: await sha("excerpta-nostr", P.key) };
  }
  const seal = async u8 => { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, K.aes, u8)); const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return o; };
  const open = async u8 => new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.subarray(0, 12) }, K.aes, u8.subarray(12)));

  async function snapshot() {
    const data = await api("/api/x/sync/export");
    return pipe(te.encode(JSON.stringify({ v: 1, dev: dev(), sent: Date.now(), data })), CompressionStream);
  }
  async function take(gz, via) {
    const msg = JSON.parse(td.decode(await pipe(gz, DecompressionStream)));
    if (msg.dev === dev() || msg.data?.library !== P.lib) return;
    peers[msg.dev] = { ...(peers[msg.dev] || {}), have: msg.data.have || [], seen: Date.now(), via };
    const r = await api("/api/x/sync/import", { method: "POST", body: JSON.stringify(msg.data) });
    const ms = Date.now() - msg.sent;
    stats[via] = { at: Date.now(), ms }; stats.got++;
    note(`${via === "direct" ? "Direct" : "Relay"} from ${msg.dev}: ${r.added} changes, ${r.cards} cards (${ms} ms after it was sent)`);
    if (r.added || r.cards) { navigator.serviceWorker.controller?.postMessage({ type: "invalidate" }); if (!getSelection().toString()) window.route?.(); }
  }

  // -- direct --------------------------------------------------------------------------------------------
  function direct() {
    room = P2P.joinRoom({ appId: "excerpta-v1", password: P.key, rtcConfig: { iceServers: STUN },
      ...(P.relays?.length ? { relayConfig: { urls: [...P.relays, ...P2P.defaultRelayUrls] } } : {}) }, K.room);
    const snap = room.makeAction("snap"), want = room.makeAction("want"), file = room.makeAction("epub");
    room.onPeerJoin(async ({ peerId }) => { peers[peerId] = { direct: true }; note("A device connected directly"); snap.send(await snapshot(), { target: peerId }); });
    room.onPeerLeave(({ peerId }) => { delete peers[peerId]; onPanel(); });
    snap.onMessage(d => take(new Uint8Array(d), "direct").catch(e => note("Could not merge: " + e.message)));
    want.onMessage(async (m, ctx) => {
      const r = await fetch(BASE + `/api/x/epub/${encodeURIComponent(m.id)}`); if (!r.ok) return;
      const id = te.encode(m.id), body = new Uint8Array(await r.arrayBuffer()), out = new Uint8Array(1 + id.length + body.length);
      out[0] = id.length; out.set(id, 1); out.set(body, 1 + id.length); file.send(out, { target: ctx.peerId });
    });
    file.onMessage(async d => {
      const u8 = new Uint8Array(d), id = td.decode(u8.subarray(1, 1 + u8[0]));
      await api("/api/books", { method: "POST", headers: { "X-Filename": id + ".epub" }, body: u8.subarray(1 + u8[0]) });
      note("Book received: " + id); window.route?.();
    });
    S.sendSnap = async () => { if (Object.keys(room.getPeers()).length) { await snap.send(await snapshot()); stats.sent++; } };
    S.want = id => want.send({ id });
  }

  // -- store and forward on public relays -------------------------------------------------------------------
  const relays = () => [...new Set([...(P.relays || []), ...RELAYS])];
  let lastAt = 0;
  async function publish() {
    const ct = await seal(await snapshot()), s = b64.to(ct), h = hex(await sha(s)).slice(0, 16), n = Math.ceil(s.length / CHUNK);
    const exp = String(Math.floor(Date.now() / 1000) + KEEP_DAYS * 86400), at = lastAt = Math.max(Math.floor(Date.now() / 1000), lastAt + 1);
    const ev = (d, content, extra = []) => P2P.finalizeEvent({ kind: KIND, created_at: at, content, tags: [["d", d], ["t", K.tag], ["h", h], ["expiration", exp], ...extra] }, K.nsk);
    const evs = [];
    for (let i = 0; i < n; i++) evs.push(ev(`${K.tag}:${dev()}:${i}`, s.slice(i * CHUNK, (i + 1) * CHUNK), [["i", String(i)]]));
    evs.push(ev(`${K.tag}:${dev()}`, JSON.stringify({ n, h, dev: dev() }), [["m", "1"]]));
    let ok = 0;
    for (const e of evs) ok += (await Promise.allSettled(pool.publish(relays(), e))).some(r => r.status === "fulfilled") ? 1 : 0;
    note(ok === evs.length ? `Saved for your other devices on public relays (${n} encrypted part${n > 1 ? "s" : ""})` : "Relays did not take the update; will retry");
    return ok === evs.length;
  }
  const done = new Set(JSON.parse(localStorage.xsyncSeen || "[]"));
  async function fetchRelays() {
    const evs = await pool.querySync(relays(), { kinds: [KIND], authors: [P2P.getPublicKey(K.nsk)], "#t": [K.tag] }, { maxWait: 5000 });
    const tag = (e, k) => e.tags.find(t => t[0] === k)?.[1];
    for (const m of evs.filter(e => tag(e, "m"))) {
      const man = JSON.parse(m.content);
      if (man.dev === dev() || done.has(man.h)) continue;
      const parts = new Map(evs.filter(e => tag(e, "h") === man.h && tag(e, "i") !== undefined).map(e => [+tag(e, "i"), e.content]));
      if (parts.size < man.n) continue;
      const s = [...Array(man.n).keys()].map(i => parts.get(i)).join("");
      try { await take(await open(b64.from(s)), "relay"); done.add(man.h); localStorage.xsyncSeen = JSON.stringify([...done].slice(-200)); }
      catch (e) { note("A relay copy could not be opened: " + e.message); }
    }
  }
  function relaysOn() {
    pool = new P2P.SimplePool();
    fetchRelays().catch(() => {});
    let t;
    sub = pool.subscribeMany(relays(), { kinds: [KIND], authors: [P2P.getPublicKey(K.nsk)], "#t": [K.tag], since: Math.floor(Date.now() / 1000) - 5 },
      { onevent: e => { if (e.tags.some(x => x[0] === "m")) { clearTimeout(t); t = setTimeout(() => fetchRelays().catch(() => {}), 1200); } } });
  }

  // -- public surface -----------------------------------------------------------------------------------------
  let t1, t2;
  const S = window.ExcSync = {
    stats, peers: () => peers, paired: () => !!P, code: () => P && `EXC1.${P.lib}.${P.key}`,
    link: () => P && `${location.origin}${BASE}/#pair=${S.code()}`,
    async start() { if (!P || room) return; K = await keys(); direct(); relaysOn(); onPanel(); },
    async create() { const { id } = await api("/api/library"); P = { lib: id, key: b64.to(crypto.getRandomValues(new Uint8Array(32))), relays: [] }; localStorage.xsync = JSON.stringify(P); await S.start(); S.changed(); },
    async join(code) {
      const m = String(code).trim().replace(/^.*#pair=/, "").match(/^EXC1\.(cp-[a-z0-9]+)\.([A-Za-z0-9_-]{43})$/);
      if (!m) throw new Error("That is not a Vicaria pairing code.");
      await S.stop(); await api("/api/x/sync/adopt", { method: "POST", body: JSON.stringify({ library: m[1] }) });
      P = { lib: m[1], key: m[2], relays: [] }; localStorage.xsync = JSON.stringify(P); await S.start(); S.changed();
    },
    async stop() { try { await room?.leave(); sub?.close(); pool?.close(relays()); } catch {} room = pool = sub = null; peers = {}; },
    async unpair() { await S.stop(); P = null; localStorage.removeItem("xsync"); onPanel(); },
    setRelays(list) { P.relays = list.filter(u => /^wss:\/\/[^\s]+$/.test(u)); localStorage.xsync = JSON.stringify(P); S.stop().then(S.start); },
    relays: () => relays(),
    changed() { if (!P || !K) return; clearTimeout(t1); clearTimeout(t2); t1 = setTimeout(() => S.sendSnap?.().catch(() => {}), 800); t2 = setTimeout(() => publish().catch(e => note("Relay error: " + e.message)), 4000); },
    syncNow: () => Promise.all([S.sendSnap?.(), publish(), fetchRelays()]),
    async exportFile() { const u8 = await seal(await snapshot()); return new Blob([te.encode("EXCERPTA-SYNC-1\n"), te.encode(b64.to(u8))], { type: "text/plain" }); },
    async importFile(text) { const s = text.trim().replace(/^(EXCERPTA|VICARIA)-SYNC-1\s*/, ""); await take(await open(b64.from(s)), "file"); },
    onPanel: f => { onPanel = f; },
  };
  if (P) S.start();
})();

// Bundled into standalone/web/vendor/p2p.js: Trystero (WebRTC over Nostr signaling), nostr-tools pieces, QR codes.
export { joinRoom, defaultRelayUrls } from "trystero";
export { finalizeEvent, getPublicKey } from "nostr-tools/pure";
export { SimplePool } from "nostr-tools/pool";
import qrcode from "qrcode-generator";
export function qrSvg(text) { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }

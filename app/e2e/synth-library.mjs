// A synthetic library for the Ideas page: n books by about n/7 authors on 12 topics, each with a few marks and tags.
// Books on the same topic share tags, so the graph has real groups. Written straight to storage, then the page reloads.
export async function seedLibrary(page, n) {
  await page.evaluate(n => new Promise((ok, bad) => {
    const words = "river night garden letters winter stone empire silent house glass ocean memory light iron road".split(" ");
    const names = "Austen Tolstoy Woolf Borges Seneca Homer Dickens Eliot Melville Cervantes Kafka Rilke Plato Kant Hume Sappho Ovid Dante".split(" ");
    const topics = "stoicism grief love war memory travel science faith politics craft childhood exile".split(" ");
    const r = indexedDB.open("vicaria");
    r.onerror = () => bad(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction(["books", "ops"], "readwrite"), bs = t.objectStore("books"), os = t.objectStore("ops"), now = Date.now();
      let k = 0;
      const op = (kind, v, book) => os.put({ id: "syn." + (++k), dev: "syn", t: now - k, c: 0, k: kind, v, bk: book });
      for (let i = 0; i < n; i++) {
        const id = "5f" + String(i).padStart(14, "0"), tp = i % 12;
        const per = Math.max(1, Math.round(n / 84)), a = tp * per + (Math.floor(i / 12) % per); // an author writes on one topic, as most do
        bs.put({ id, sha256: id, title: `The ${words[i % 15]} of ${words[(i * 7) % 15]} ${i}`, author: `${names[a % 18]} ${Math.floor(a / 18) + 1}`, lang: "en", cover: null, addedAt: now - i * 1000, start: 0, dir: "ltr", vertical: false, fixedLayout: false, v: 1, words: 1000 + i, sections: 1, storage: "idb", size: 1000 });
        const marks = 1 + (i % 4);
        for (let m = 0; m < marks; m++) {
          const mid = `sm${i}_${m}`;
          op("mark", { id: mid, book: id, set: { at: { section: 0, block: m, offset: 0, exact: "a quoted passage", prefix: "", suffix: "" }, color: "yellow", made: now - k } }, id);
          op("mark", { id: mid, book: id, tag: topics[(tp + (m && i % 3 === 0 ? 1 : 0)) % 12]  }, id);
        }
      }
      t.oncomplete = ok; t.onerror = () => bad(t.error);
    };
  }), n);
}

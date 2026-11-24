import { describe, it, expect } from "vitest";
import { pickLang, format } from "../src/core/i18n";
import { en } from "../src/i18n/en";
import { es } from "../src/i18n/es";

const slots = (s: string) => [...s.matchAll(/\{(\w+)\s*[,}]/g)].map(m => m[1]).sort().join(",");

describe("interface language", () => {
  it("takes the saved choice, then the browser's list, then English", () => {
    expect(pickLang("es", ["en-US"])).toBe("es");
    expect(pickLang(null, ["fr-FR", "es-EC", "en"])).toBe("es");
    expect(pickLang("de", ["pt-BR"])).toBe("en");
    expect(pickLang(null, [])).toBe("en");
  });
  it("fills slots and picks plural forms per language", () => {
    expect(format("en", "Hello {name}", { name: "Ana" })).toBe("Hello Ana");
    const m = "{n, plural, =0 {No books} one {# book} other {# books}}";
    expect(format("en", m, { n: 0 })).toBe("No books");
    expect(format("en", m, { n: 1 })).toBe("1 book");
    expect(format("en", m, { n: 1000 })).toBe("1,000 books");
    expect(format("es", "{n, plural, one {# libro} other {# libros}}", { n: 2 })).toBe("2 libros");
    expect(format("en", "keep {missing}", {})).toBe("keep {missing}");
    expect(format("en", "You have {n, plural, one {# book} other {# books}} in {where}", { n: 2, where: "Quito" })).toBe("You have 2 books in Quito");
  });
  it("Spanish has exactly the keys and slots of English, none empty, none left in English by accident", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(es[k].trim(), k).not.toBe("");
      expect(slots(es[k]), k).toBe(slots(en[k]));
      expect(es[k].includes("\u2014") || en[k].includes("\u2014"), `${k} has an em dash`).toBe(false);
    }
  });
});

import { tparts } from "../src/core/i18n";
describe("a message around a link", () => {
  it("splits at the slot", () => {
    expect(tparts("library.hint", "discover")).toEqual(["Drop EPUB or PDF files anywhere on this page, or find free classics in ", "."]);
  });
});

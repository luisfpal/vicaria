import { describe, it, expect } from "vitest";
// @ts-expect-error plain script
import { buildLatest } from "../scripts/latest-json.mjs";

const base = "https://github.com/luisfpal/vicaria/releases/download/v0.9.2";
describe("latest.json", () => {
  it("maps each update file to its platform with its signature and url", () => {
    const j = buildLatest({ version: "0.9.2", notes: "n", base, date: new Date("2026-11-21T00:00:00Z"), files: {
      "Vicaria_0.9.2_aarch64.app.tar.gz": "", "Vicaria_0.9.2_aarch64.app.tar.gz.sig": "SIGA\n",
      "Vicaria_0.9.2_amd64.AppImage": "", "Vicaria_0.9.2_amd64.AppImage.sig": "SIGL",
      "Vicaria_0.9.2_aarch64.dmg": "" } });
    expect(j.version).toBe("0.9.2");
    expect(j.pub_date).toBe("2026-11-21T00:00:00.000Z");
    expect(Object.keys(j.platforms).sort()).toEqual(["darwin-aarch64", "linux-x86_64"]);
    expect(j.platforms["darwin-aarch64"]).toEqual({ signature: "SIGA", url: `${base}/Vicaria_0.9.2_aarch64.app.tar.gz` });
    expect(j.platforms["linux-x86_64"].url).toBe(`${base}/Vicaria_0.9.2_amd64.AppImage`);
  });
  it("refuses an update file without a signature, and an empty release", () => {
    expect(() => buildLatest({ version: "1", base, files: { "Vicaria_1_aarch64.app.tar.gz": "" } })).toThrow(/no \.sig/);
    expect(() => buildLatest({ version: "1", base, files: { "Vicaria_1_aarch64.dmg": "" } })).toThrow(/no update files/);
  });
});

import { describe, it, expect } from "vitest";
// @ts-expect-error plain module shared with the static page
import { detect, assetFor, TEXT } from "../../get/pick.mjs";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
};
describe("Get Vicaria", () => {
  it("tells each device apart, including an iPad that says it is a Mac", () => {
    expect(detect(UA.iphone, "iPhone", 5)).toBe("ios");
    expect(detect(UA.ipad, "MacIntel", 5)).toBe("ios");
    expect(detect(UA.mac, "MacIntel", 0)).toBe("mac");
    expect(detect(UA.android, "Linux armv8l", 5)).toBe("android");
    expect(detect(UA.linux, "Linux x86_64", 0)).toBe("linux");
    expect(detect(UA.windows, "Win32", 0)).toBe("windows");
    expect(detect("curl/8", "", 0)).toBe("other");
  });
  const assets = ["Vicaria_1.0.0_aarch64.dmg", "Vicaria_1.0.0_x64.dmg", "Vicaria_1.0.0_amd64.AppImage", "Vicaria_1.0.0_amd64.deb", "Vicaria_1.0.0_android.apk", "latest.json"].map(name => ({ name, browser_download_url: "https://x/" + name }));
  it("picks the right file of a release", () => {
    expect(assetFor("android", assets)).toEqual({ apk: "https://x/Vicaria_1.0.0_android.apk" });
    expect(assetFor("mac", assets)).toEqual({ arm: "https://x/Vicaria_1.0.0_aarch64.dmg", intel: "https://x/Vicaria_1.0.0_x64.dmg" });
    expect(assetFor("linux", assets).appimage).toBe("https://x/Vicaria_1.0.0_amd64.AppImage");
    expect(assetFor("mac", []).arm).toBeNull();
  });
  it("English and Spanish have the same texts and no em dashes", () => {
    expect(Object.keys(TEXT.es).sort()).toEqual(Object.keys(TEXT.en).sort());
    for (const l of ["en", "es"]) expect(JSON.stringify(TEXT[l])).not.toContain("\u2014");
  });
});

import { describe, it, expect } from "vitest";
import { nativeUpdater, type Found, type NativeDeps } from "../src/ui/nativeupdate";

function rig(over: Partial<NativeDeps> = {}, found: Found | null = null) {
  const log: string[] = [];
  const idle: (() => void)[] = [];
  let busy = false;
  const deps: NativeDeps = {
    check: async () => found,
    relaunch: async () => { log.push("relaunch"); },
    isBusy: () => busy,
    whenIdle: f => { idle.push(f); },
    offer: (v, install) => { log.push(`offer ${v}`); idle.push(install); },
    failed: (v, why) => log.push(`failed ${v}: ${why}`),
    ...over,
  };
  return { log, idle, deps, setBusy: (b: boolean) => { busy = b; } };
}
const upd = (log: string[], fail?: string): Found => ({ version: "0.9.2", downloadAndInstall: async () => { if (fail) throw new Error(fail); log.push("install"); } });

describe("desktop updates", () => {
  it("installs at once at launch when nothing is busy, then restarts", async () => {
    const r = rig(); const u = upd(r.log); r.deps.check = async () => u;
    await nativeUpdater(r.deps).run(true); await Promise.resolve(); await new Promise(x => setTimeout(x));
    expect(r.log).toEqual(["install", "relaunch"]);
  });
  it("offers instead when the reader has been working, and installs only when idle", async () => {
    const r = rig(); const u = upd(r.log); r.deps.check = async () => u;
    const n = nativeUpdater(r.deps);
    await n.run(false); await n.run(false);
    expect(r.log).toEqual(["offer 0.9.2"]); // the same version is offered once
    r.idle[0](); r.idle[1]?.(); await new Promise(x => setTimeout(x));
    expect(r.log).toEqual(["offer 0.9.2", "install", "relaunch"]);
  });
  it("at launch with open work it offers, and never restarts over that work", async () => {
    const r = rig(); const u = upd(r.log); r.deps.check = async () => u; r.setBusy(true);
    await nativeUpdater(r.deps).run(true);
    expect(r.log).toEqual(["offer 0.9.2"]);
  });
  it("says so when installing fails and does not restart", async () => {
    const r = rig(); const u = upd(r.log, "signature refused"); r.deps.check = async () => u;
    await nativeUpdater(r.deps).run(true); await new Promise(x => setTimeout(x));
    expect(r.log).toEqual(["failed 0.9.2: signature refused"]);
  });
  it("does nothing with no update or no connection", async () => {
    const r = rig(); await nativeUpdater(r.deps).run(true);
    const r2 = rig({ check: async () => { throw new Error("offline"); } }); await nativeUpdater(r2.deps).run(true);
    expect(r.log).toEqual([]); expect(r2.log).toEqual([]);
  });
});

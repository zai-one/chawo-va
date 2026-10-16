import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards against box-local artefacts sneaking into commits (a tracked
// `ts/node_modules` symlink once landed on main via a merge).
function trackedEntries(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-s"], { cwd: __dirname, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter(Boolean);
  } catch {
    return null; // not a git checkout (e.g. source tarball) — nothing to check
  }
}

describe("repository hygiene", () => {
  const entries = trackedEntries();

  it.skipIf(entries === null)("tracks no symlinks", () => {
    const links = entries!.filter((l) => l.startsWith("120000 ")).map((l) => l.split("\t")[1]);
    expect(links).toEqual([]);
  });

  it.skipIf(entries === null)("tracks no node_modules, build output or tick locks", () => {
    const bad = entries!
      .map((l) => l.split("\t")[1])
      .filter((p) => /(^|\/)(node_modules|\.tick-lock)(\/|$)/.test(p) || /^(apps|packages)\/[^/]+\/(out|dist|release)\//.test(p));
    expect(bad).toEqual([]);
  });

  it("ChawoNative.csproj comments are valid XML (no '--' inside, MSBuild refuses the file otherwise)", () => {
    const csproj = readFileSync(join(__dirname, "..", "native", "win", "ChawoNative.csproj"), "utf8");
    const bad = Array.from(csproj.matchAll(/<!--([\s\S]*?)-->/g), (m) => m[1]).filter((c) => c.includes("--") || c.endsWith("-"));
    expect(bad).toEqual([]);
  });
});

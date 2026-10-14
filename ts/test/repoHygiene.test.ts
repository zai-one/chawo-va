import { execFileSync } from "node:child_process";
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

  it.skipIf(entries === null)("tracks no node_modules, dist or tick locks", () => {
    const bad = entries!
      .map((l) => l.split("\t")[1])
      .filter((p) => /(^|\/)(node_modules|\.tick-lock)(\/|$)/.test(p) || /^ts\/dist\//.test(p));
    expect(bad).toEqual([]);
  });
});

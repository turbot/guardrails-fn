const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

// Agent Fleet finds its files (the declaration, the gate manifest and the rest) in
// .claude/agent-fleet/ first and .claude/ otherwise. Nothing in this repo opens them, so
// nothing here should spell out where they live: name the file, not its path, and a
// later move needs no edit here.
const NAMES = [
  "agent-fleet.json",
  "inbox-gates.yml",
  "inbox-judgement.md",
  "inbox-intake.md",
  "self-review-checklist.md",
  "agent-worker.json", // the declaration's old name, still read
];
const HAND_TYPED = new RegExp(
  "\\.claude/(?:agent-fleet/|rules/)?(?:" + NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")"
);

// Repo-relative files whose subject is the location itself.
const ALLOWED = new Set([]);
const SKIP_DIRS = new Set([".git", "node_modules", ".nyc_output", "dist"]);

const root = path.join(__dirname, "..");

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
    return entry.isFile() ? [full] : [];
  });

describe("Agent Fleet file paths", () => {
  it("are not hand-typed anywhere in the repo", () => {
    const offenders = [];
    for (const file of walk(root)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (HAND_TYPED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, "name the file, not its path").to.deep.equal([]);
  });
});

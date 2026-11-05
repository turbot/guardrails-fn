const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Every .npmrc line that is not a comment or blank, as { key: value }.
const parseNpmrc = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"))
    .reduce((acc, line) => {
      const i = line.indexOf("=");
      if (i > 0) acc[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      return acc;
    }, {});

// A workflow that is parked under .github/pending/ stands in for its live copy until a person
// moves it (agents may not write .github/workflows/).
const workflowFiles = () => {
  const dirs = { workflows: ".github/workflows", pending: ".github/pending" };
  const list = (dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)) : []);
  const byName = {};
  for (const name of list(dirs.workflows)) byName[name] = `${dirs.workflows}/${name}`;
  for (const name of list(dirs.pending)) byName[name] = `${dirs.pending}/${name}`;
  return Object.values(byName).filter((f) => /\.ya?ml$/.test(f));
};

describe("npm install scripts", () => {
  it("are off for every install in this repo (.npmrc)", () => {
    expect(fs.existsSync(path.join(root, ".npmrc")), ".npmrc exists").to.equal(true);
    expect(parseNpmrc(read(".npmrc"))["ignore-scripts"]).to.equal("true");
  });

  it("are not needed by any package in package-lock.json", () => {
    const lock = JSON.parse(read("package-lock.json"));
    const needing = Object.entries(lock.packages || {})
      .filter(([, pkg]) => pkg.hasInstallScript)
      .map(([name]) => name);
    expect(needing, "packages with an install script; ignore-scripts would skip it").to.deep.equal([]);
  });

  it("are off in every workflow step that installs packages", () => {
    const offenders = [];
    for (const file of workflowFiles()) {
      read(file)
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\bnpm\s+(ci|install|i)\b/.test(line) && !/--ignore-scripts\b/.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).to.deep.equal([]);
  });

  it("the parser reads an .npmrc that turns them on as not off", () => {
    expect(parseNpmrc("# ignore-scripts=true\nignore-scripts=false\n")["ignore-scripts"]).to.equal("false");
    expect(parseNpmrc("# ignore-scripts=true\n")["ignore-scripts"]).to.equal(undefined);
  });
});

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const root = path.join(__dirname, "..");
const MODEL = path.join(root, "THREAT-MODEL.md");

// Each entry is a boundary or asset the threat model must name, and the text that proves the model covers it.
const MUST_NAME = {
  "the SNS message into initialize": ["@turbot/sns-validator", "TURBOT_TEST", "initialize"],
  "the presigned S3 GET zip": ["expandEventData", "large-input.json", "s3PresignedUrlForParameterGet"],
  "the presigned S3 PUT": ["persistLargeCommands", "s3PresignedUrl"],
  "the container parameters URL and KMS envelope": [
    "TURBOT_CONTROL_CONTAINER_PARAMETERS",
    "decryptContainerParameters",
    "AES-256-GCM",
    "purpose",
  ],
  "the ECS credentials endpoint": ["169.254.170.2", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"],
  "credentials in process.env": ["process.env", "restoreCachedAWSEnvVars", "finalize"],
  logs: ["@turbot/log", "console.log", "sanitiz"],
  "the fleet's own boundaries": [".claude/settings.json", "agent:ready", "Dependabot"],
};

// Functions the model points a reader at. If one is renamed or removed, the model is out of date.
const CODE_ANCHORS = [
  "initialize",
  "expandEventData",
  "persistLargeCommands",
  "decryptContainerParameters",
  "restoreCachedAWSEnvVars",
  "setAWSEnvVars",
  "finalize",
];

describe("THREAT-MODEL.md", () => {
  let model;
  before(() => {
    model = fs.readFileSync(MODEL, "utf8");
  });

  it("exists at the repo root", () => {
    expect(fs.existsSync(MODEL)).to.equal(true);
  });

  Object.entries(MUST_NAME).forEach(([boundary, terms]) => {
    it(`names ${boundary} and its control`, () => {
      const missing = terms.filter((t) => !model.includes(t));
      expect(missing, `THREAT-MODEL.md does not mention: ${missing.join(", ")}`).to.deep.equal([]);
    });
  });

  it("lists the assets", () => {
    ["AWS credentials", "Presigned S3 URLs", "KMS data key"].forEach((asset) => {
      expect(model, asset).to.include(asset);
    });
  });

  it("points only at functions that still exist in index.js", () => {
    const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
    const gone = CODE_ANCHORS.filter((name) => !new RegExp(`(const|function)\\s+${name}\\b`).test(source));
    expect(gone, `index.js no longer defines: ${gone.join(", ")}; update THREAT-MODEL.md and this list`).to.deep.equal(
      []
    );
    CODE_ANCHORS.forEach((name) => expect(model, `${name} is not in THREAT-MODEL.md`).to.include(name));
  });

  it("is checked against the settings file and workflow it describes", () => {
    expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).to.equal(true);
    const dependabot = fs.readFileSync(path.join(root, ".github", "dependabot.yml"), "utf8");
    expect(dependabot, "the model says Dependabot PRs carry agent:ready").to.include("agent:ready");
  });
});

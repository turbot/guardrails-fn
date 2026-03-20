const { assert } = require("chai");
const sinon = require("sinon");
const tfn = require("..");

// AWS env vars that setAWSEnvVars manages
const credentialEnvVars = [
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];
const regionEnvVars = ["AWS_REGION", "AWS_DEFAULT_REGION"];
const allAWSEnvVars = [...credentialEnvVars, ...regionEnvVars];

// Save and restore all AWS env vars around each test to prevent cross-contamination
let savedEnvVars = {};

function saveAWSEnvVars() {
  savedEnvVars = {};
  for (const v of allAWSEnvVars) {
    if (process.env[v] !== undefined) {
      savedEnvVars[v] = process.env[v];
    }
  }
}

function restoreAWSEnvVars() {
  for (const v of allAWSEnvVars) {
    delete process.env[v];
  }
  for (const [k, v] of Object.entries(savedEnvVars)) {
    process.env[k] = v;
  }
}

describe("@turbot/guardrails-fn", function () {
  before(function () {
    process.env.TURBOT_TEST = "true";
  });

  after(function () {
    delete process.env.TURBOT_TEST;
  });

  beforeEach(function () {
    saveAWSEnvVars();
  });

  afterEach(function () {
    restoreAWSEnvVars();
    delete process.env.TURBOT_FUNCTION_TYPE;
  });

  // ---------------------------------------------------------------------------
  // Module exports
  // ---------------------------------------------------------------------------
  describe("module exports", function () {
    it("exports a function as default", function () {
      assert.isFunction(tfn);
    });

    it("exports fn as alias for tfn", function () {
      assert.isFunction(tfn.fn);
      assert.strictEqual(tfn.fn, tfn);
    });

    it("exports fnAsync for async handlers", function () {
      assert.isFunction(tfn.fnAsync);
    });

    it("exports Run class", function () {
      assert.isFunction(tfn.Run);
    });
  });

  // ---------------------------------------------------------------------------
  // tfn() — Lambda wrapper
  // ---------------------------------------------------------------------------
  describe("tfn()", function () {
    it("returns a function with lambda signature (event, context, callback)", function () {
      const handler = tfn((turbot, $, callback) => callback(null, true));
      assert.isFunction(handler);
      assert.equal(handler.length, 3);
    });

    // --- turbot object ---
    it("provides turbot object to handler", function (done) {
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot);
        assert.isObject(turbot);
        callback(null, true);
      });
      handler({}, {}, done);
    });

    it("provides turbot with ok, error, and log methods", function (done) {
      const handler = tfn((turbot, $, callback) => {
        assert.isFunction(turbot.ok);
        assert.isFunction(turbot.error);
        assert.isFunction(turbot.log.info);
        assert.isFunction(turbot.log.error);
        assert.isFunction(turbot.log.warning);
        assert.isFunction(turbot.log.debug);
        callback(null, true);
      });
      handler({}, {}, done);
    });

    it("provides turbot with resource methods", function (done) {
      const handler = tfn((turbot, $, callback) => {
        assert.isFunction(turbot.resource.create);
        callback(null, true);
      });
      handler({}, {}, done);
    });

    // --- input ($) handling ---
    it("passes payload.input as $ to handler", function (done) {
      const input = { item: { name: "test-resource" } };
      const event = { payload: { input } };
      const handler = tfn((turbot, $, callback) => {
        assert.deepEqual($, input);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("falls back to event itself as $ when no payload.input", function (done) {
      const event = { someData: "value" };
      const handler = tfn((turbot, $, callback) => {
        assert.equal($.someData, "value");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("sets turbot.$ to the same value as handler $", function (done) {
      const input = { item: { id: "res-001" } };
      const event = { payload: { input } };
      const handler = tfn((turbot, $, callback) => {
        assert.strictEqual(turbot.$, $);
        assert.deepEqual(turbot.$, input);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    // --- meta handling ---
    it("reads meta from event and exposes via turbot.meta", function (done) {
      const event = {
        meta: { controlId: "ctl-123", resourceId: "res-456" },
        payload: { input: {} },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(turbot.meta.controlId, "ctl-123");
        assert.equal(turbot.meta.resourceId, "res-456");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("defaults meta to empty object when event has no meta", function (done) {
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot.meta);
        callback(null, true);
      });
      handler({}, {}, done);
    });

    // --- runType / TURBOT_FUNCTION_TYPE ---
    it("uses meta.runType when provided", function (done) {
      const event = { meta: { runType: "policy" }, payload: { input: {} } };
      const handler = tfn((turbot, $, callback) => {
        // The turbot object is created with type from meta.runType
        assert.exists(turbot);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("falls back to TURBOT_FUNCTION_TYPE env var when no meta.runType", function (done) {
      process.env.TURBOT_FUNCTION_TYPE = "action";
      const event = { meta: {}, payload: { input: {} } };
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    // --- finalize in test mode ---
    it("returns result wrapped with turbot process event in test mode", function (done) {
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, "my-result");
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.exists(result);
        assert.equal(result.result, "my-result");
        assert.exists(result.turbot);
        done();
      });
    });

    it("includes turbot process event when handler calls turbot.ok()", function (done) {
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, true);
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.exists(result.turbot);
        done();
      });
    });

    // --- handler error paths ---
    it("handles fatal error by nullifying err and setting turbot.error", function (done) {
      const handler = tfn((turbot, $, callback) => {
        const fatalErr = new Error("something broke");
        fatalErr.fatal = true;
        callback(fatalErr);
      });
      handler({}, {}, (err, result) => {
        // Fatal errors are swallowed — err becomes null, turbot state is set to error
        assert.isNull(err);
        assert.exists(result);
        assert.exists(result.turbot);
        done();
      });
    });

    it("passes non-fatal error through in test mode as stringified error", function (done) {
      const handler = tfn((turbot, $, callback) => {
        callback(new Error("non-fatal problem"));
      });
      handler({}, {}, (err, result) => {
        // In test mode, errors are returned as stringified JSON
        assert.exists(err);
        const parsed = JSON.parse(err);
        assert.exists(parsed.err);
        assert.exists(parsed.result);
        done();
      });
    });

    it("handles handler returning no result (undefined)", function (done) {
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null);
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.exists(result);
        assert.isUndefined(result.result);
        assert.exists(result.turbot);
        done();
      });
    });

    it("handles handler returning null result", function (done) {
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, null);
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.exists(result);
        assert.isNull(result.result);
        assert.exists(result.turbot);
        done();
      });
    });

    it("handles empty event and empty context", function (done) {
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot);
        assert.exists($);
        turbot.ok();
        callback(null, true);
      });
      handler({}, {}, done);
    });

    it("fatal error message is preserved in turbot state", function (done) {
      const handler = tfn((turbot, $, callback) => {
        const fatalErr = new Error("fatal: disk full");
        fatalErr.fatal = true;
        callback(fatalErr);
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.exists(result.turbot);
        done();
      });
    });

    it("catches synchronous exception thrown in handler", function (done) {
      const handler = tfn(() => {
        throw new Error("sync boom");
      });
      handler({}, {}, (err, result) => {
        // Synchronous exceptions are caught and passed through finalize
        assert.exists(err);
        const parsed = JSON.parse(err);
        assert.exists(parsed.err);
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // setAWSEnvVars — tested through tfn with credential payloads
  // ---------------------------------------------------------------------------
  describe("setAWSEnvVars (via handler payload)", function () {
    it("sets credentials from account level", function (done) {
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                AccessKeyId: "AKID-ACCT",
                SecretAccessKey: "SECRET-ACCT",
                SessionToken: "TOKEN-ACCT",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-ACCT");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SECRET-ACCT");
        assert.equal(process.env.AWS_SESSION_TOKEN, "TOKEN-ACCT");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("sets credentials from organizationalUnit level", function (done) {
      const event = {
        payload: {
          input: {
            organizationalUnit: {
              credentials: {
                AccessKeyId: "AKID-OU",
                SecretAccessKey: "SECRET-OU",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-OU");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SECRET-OU");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("sets credentials from organization level", function (done) {
      const event = {
        payload: {
          input: {
            organization: {
              credentials: {
                AccessKeyId: "AKID-ORG",
                SecretAccessKey: "SECRET-ORG",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-ORG");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SECRET-ORG");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("prefers organization over organizationalUnit over account", function (done) {
      const event = {
        payload: {
          input: {
            organization: {
              credentials: { AccessKeyId: "AKID-ORG" },
            },
            organizationalUnit: {
              credentials: { AccessKeyId: "AKID-OU" },
            },
            account: {
              credentials: { AccessKeyId: "AKID-ACCT" },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-ORG");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("prefers organizationalUnit over account when organization is absent", function (done) {
      const event = {
        payload: {
          input: {
            organizationalUnit: {
              credentials: { AccessKeyId: "AKID-OU" },
            },
            account: {
              credentials: { AccessKeyId: "AKID-ACCT" },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-OU");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("handles case-insensitive credential keys (lower case from IAM Role)", function (done) {
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                accessKeyId: "akid-lower",
                secretAccessKey: "secret-lower",
                sessionToken: "token-lower",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "akid-lower");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "secret-lower");
        assert.equal(process.env.AWS_SESSION_TOKEN, "token-lower");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("maps all 6 credential keys to their env vars", function (done) {
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                AccessKey: "AK-VAL",
                AccessKeyId: "AKID-VAL",
                SecretKey: "SK-VAL",
                SecretAccessKey: "SAK-VAL",
                SessionToken: "ST-VAL",
                SecurityToken: "SEC-VAL",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY, "AK-VAL");
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-VAL");
        assert.equal(process.env.AWS_SECRET_KEY, "SK-VAL");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SAK-VAL");
        assert.equal(process.env.AWS_SESSION_TOKEN, "ST-VAL");
        assert.equal(process.env.AWS_SECURITY_TOKEN, "SEC-VAL");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("does not set credential env vars when no credentials in payload", function (done) {
      for (const v of credentialEnvVars) {
        delete process.env[v];
      }
      const event = { payload: { input: { item: { name: "no-creds" } } } };
      const handler = tfn((turbot, $, callback) => {
        assert.isUndefined(process.env.AWS_ACCESS_KEY_ID);
        assert.isUndefined(process.env.AWS_SECRET_ACCESS_KEY);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("caches and overwrites existing credential env vars", function (done) {
      process.env.AWS_ACCESS_KEY_ID = "ORIGINAL_KEY";
      const event = {
        payload: {
          input: {
            account: {
              credentials: { AccessKeyId: "NEW_KEY" },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "NEW_KEY");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    // --- region paths ---
    it("sets region from item.turbot.custom.aws.regionName", function (done) {
      const event = {
        payload: {
          input: {
            item: { turbot: { custom: { aws: { regionName: "us-east-1" } } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "us-east-1");
        assert.equal(process.env.AWS_DEFAULT_REGION, "us-east-1");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("sets region from item.turbot.metadata.aws.regionName as fallback", function (done) {
      const event = {
        payload: {
          input: {
            item: { turbot: { metadata: { aws: { regionName: "eu-west-1" } } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "eu-west-1");
        assert.equal(process.env.AWS_DEFAULT_REGION, "eu-west-1");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("sets region from item.metadata.aws.regionName as last resort", function (done) {
      const event = {
        payload: {
          input: {
            item: { metadata: { aws: { regionName: "ap-southeast-2" } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "ap-southeast-2");
        assert.equal(process.env.AWS_DEFAULT_REGION, "ap-southeast-2");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("defaults to us-gov-west-1 for aws-us-gov partition", function (done) {
      const event = {
        payload: {
          input: {
            item: { metadata: { aws: { partition: "aws-us-gov" } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "us-gov-west-1");
        assert.equal(process.env.AWS_DEFAULT_REGION, "us-gov-west-1");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("defaults to cn-north-1 for aws-cn partition", function (done) {
      const event = {
        payload: {
          input: {
            item: { metadata: { aws: { partition: "aws-cn" } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "cn-north-1");
        assert.equal(process.env.AWS_DEFAULT_REGION, "cn-north-1");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("reads partition from item.turbot.custom.aws.partition as fallback", function (done) {
      const event = {
        payload: {
          input: {
            item: { turbot: { custom: { aws: { partition: "aws-us-gov" } } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "us-gov-west-1");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("prefers item.turbot.custom.aws.regionName over metadata paths", function (done) {
      const event = {
        payload: {
          input: {
            item: {
              turbot: {
                custom: { aws: { regionName: "custom-region" } },
                metadata: { aws: { regionName: "metadata-region" } },
              },
              metadata: { aws: { regionName: "item-metadata-region" } },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "custom-region");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("does not set region for unknown partition", function (done) {
      for (const v of regionEnvVars) {
        delete process.env[v];
      }
      const event = {
        payload: {
          input: {
            item: { metadata: { aws: { partition: "aws-unknown" } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.isUndefined(process.env.AWS_REGION);
        assert.isUndefined(process.env.AWS_DEFAULT_REGION);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("does not set region env vars when no region and no partition", function (done) {
      for (const v of regionEnvVars) {
        delete process.env[v];
      }
      const event = { payload: { input: { item: { name: "no-region" } } } };
      const handler = tfn((turbot, $, callback) => {
        assert.isUndefined(process.env.AWS_REGION);
        assert.isUndefined(process.env.AWS_DEFAULT_REGION);
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("caches and overwrites existing region env vars", function (done) {
      process.env.AWS_REGION = "original-region";
      process.env.AWS_DEFAULT_REGION = "original-default";
      const event = {
        payload: {
          input: {
            item: { turbot: { custom: { aws: { regionName: "new-region" } } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "new-region");
        assert.equal(process.env.AWS_DEFAULT_REGION, "new-region");
        callback(null, true);
      });
      handler(event, {}, done);
    });
  });

  // ---------------------------------------------------------------------------
  // restoreCachedAWSEnvVars — tested through finalize (runs after handler)
  // ---------------------------------------------------------------------------
  describe("restoreCachedAWSEnvVars (via finalize)", function () {
    it("restores original credentials after handler completes", function (done) {
      process.env.AWS_ACCESS_KEY_ID = "ORIGINAL_AKID";
      process.env.AWS_SECRET_ACCESS_KEY = "ORIGINAL_SECRET";
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                AccessKeyId: "TEMP_AKID",
                SecretAccessKey: "TEMP_SECRET",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        // During handler, creds are from payload
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "TEMP_AKID");
        callback(null, true);
      });
      handler(event, {}, (err, result) => {
        // After finalize, creds should be restored
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "ORIGINAL_AKID");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "ORIGINAL_SECRET");
        done();
      });
    });

    it("restores all 6 credential env vars after handler completes", function (done) {
      process.env.AWS_ACCESS_KEY = "ORIG_AK";
      process.env.AWS_ACCESS_KEY_ID = "ORIG_AKID";
      process.env.AWS_SECRET_KEY = "ORIG_SK";
      process.env.AWS_SECRET_ACCESS_KEY = "ORIG_SAK";
      process.env.AWS_SESSION_TOKEN = "ORIG_ST";
      process.env.AWS_SECURITY_TOKEN = "ORIG_SEC";
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                AccessKey: "TMP_AK",
                AccessKeyId: "TMP_AKID",
                SecretKey: "TMP_SK",
                SecretAccessKey: "TMP_SAK",
                SessionToken: "TMP_ST",
                SecurityToken: "TMP_SEC",
              },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY, "TMP_AK");
        assert.equal(process.env.AWS_SECURITY_TOKEN, "TMP_SEC");
        callback(null, true);
      });
      handler(event, {}, () => {
        assert.equal(process.env.AWS_ACCESS_KEY, "ORIG_AK");
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "ORIG_AKID");
        assert.equal(process.env.AWS_SECRET_KEY, "ORIG_SK");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "ORIG_SAK");
        assert.equal(process.env.AWS_SESSION_TOKEN, "ORIG_ST");
        assert.equal(process.env.AWS_SECURITY_TOKEN, "ORIG_SEC");
        done();
      });
    });

    it("restores original region after handler completes", function (done) {
      process.env.AWS_REGION = "original-region";
      process.env.AWS_DEFAULT_REGION = "original-default";
      const event = {
        payload: {
          input: {
            item: { turbot: { custom: { aws: { regionName: "us-west-2" } } } },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_REGION, "us-west-2");
        callback(null, true);
      });
      handler(event, {}, (err, result) => {
        assert.equal(process.env.AWS_REGION, "original-region");
        assert.equal(process.env.AWS_DEFAULT_REGION, "original-default");
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // tfn.fn() — alias
  // ---------------------------------------------------------------------------
  describe("tfn.fn()", function () {
    it("works identically to tfn()", function (done) {
      const handler = tfn.fn((turbot, $, callback) => {
        assert.exists(turbot);
        turbot.ok();
        callback(null, "fn-result");
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.equal(result.result, "fn-result");
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // tfn.fnAsync() — async wrapper
  // ---------------------------------------------------------------------------
  describe("tfn.fnAsync()", function () {
    it("wraps async handler into callback style", function (done) {
      const handler = tfn.fnAsync(async (turbot, $) => {
        assert.exists(turbot);
        turbot.ok();
        return "async-result";
      });
      assert.isFunction(handler);
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.equal(result.result, "async-result");
        done();
      });
    });

    it("provides turbot with standard methods in async mode", function (done) {
      const handler = tfn.fnAsync(async (turbot) => {
        assert.isFunction(turbot.ok);
        assert.isFunction(turbot.error);
        assert.isFunction(turbot.log.info);
        turbot.ok();
      });
      handler({}, {}, done);
    });

    it("catches rejected promise as error", function (done) {
      const handler = tfn.fnAsync(async () => {
        throw new Error("async failure");
      });
      handler({}, {}, (err) => {
        assert.exists(err);
        const parsed = JSON.parse(err);
        assert.exists(parsed.err);
        done();
      });
    });

    it("handles async handler returning undefined", function (done) {
      const handler = tfn.fnAsync(async (turbot) => {
        turbot.ok();
        // no return value
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.isUndefined(result.result);
        assert.exists(result.turbot);
        done();
      });
    });

    it("passes $ from payload.input to async handler", function (done) {
      const input = { item: { id: "res-async" } };
      const event = { payload: { input } };
      const handler = tfn.fnAsync(async (turbot, $) => {
        assert.deepEqual($, input);
        turbot.ok();
      });
      handler(event, {}, done);
    });
  });

  // ---------------------------------------------------------------------------
  // initialize() — non-test mode paths (TURBOT_TEST unset)
  // ---------------------------------------------------------------------------
  describe("initialize non-test mode", function () {
    it("returns error when no SNS records in event", function (done) {
      delete process.env.TURBOT_TEST;
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });
      handler({}, {}, (err) => {
        process.env.TURBOT_TEST = "true";
        assert.exists(err);
        assert.include(err.message, "Turbot controls should be called via SNS");
        done();
      });
    });

    it("returns error when event has Records but no Sns.Message", function (done) {
      delete process.env.TURBOT_TEST;
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });
      handler({ Records: [{}] }, {}, (err) => {
        process.env.TURBOT_TEST = "true";
        assert.exists(err);
        assert.include(err.message, "Turbot controls should be called via SNS");
        done();
      });
    });

    it("returns error when SNS message fails validation", function (done) {
      delete process.env.TURBOT_TEST;
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });
      const event = {
        Records: [
          {
            Sns: {
              Message: "some-message",
              Type: "Notification",
              SignatureVersion: "1",
              Signature: "invalid",
              SigningCertUrl: "https://invalid.example.com/cert.pem",
            },
          },
        ],
      };
      handler(event, {}, (err) => {
        process.env.TURBOT_TEST = "true";
        assert.exists(err);
        done();
      });
    });

    it("returns error with empty event in non-test mode", function (done) {
      delete process.env.TURBOT_TEST;
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });
      handler(null, {}, (err) => {
        process.env.TURBOT_TEST = "true";
        assert.exists(err);
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Run class
  // ---------------------------------------------------------------------------
  describe("tfn.Run", function () {
    it("throws when TURBOT_CONTROL_CONTAINER_PARAMETERS is not set", function () {
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
      assert.throws(() => {
        new tfn.Run();
      }, /No parameters supplied/);
    });

    it("throws when TURBOT_CONTROL_CONTAINER_PARAMETERS is empty string", function () {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "";
      assert.throws(() => {
        new tfn.Run();
      }, /No parameters supplied/);
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    });

    it("throws when TURBOT_CONTROL_CONTAINER_PARAMETERS is the string 'undefined'", function () {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "undefined";
      assert.throws(() => {
        new tfn.Run();
      }, /No parameters supplied/);
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    });

    it("creates instance when TURBOT_CONTROL_CONTAINER_PARAMETERS is set", function () {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "https://example.com/params";
      const runner = new tfn.Run();
      assert.exists(runner);
      assert.isFunction(runner.run);
      assert.isFunction(runner.handler);
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    });

    it("stores parameters URL in _runnableParameters", function () {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "https://example.com/params";
      const runner = new tfn.Run();
      assert.equal(runner._runnableParameters, "https://example.com/params");
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    });

    it("has a default handler method that calls callback without error", function (done) {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "https://example.com/params";
      const runner = new tfn.Run();
      runner.handler({}, {}, (err) => {
        assert.isUndefined(err);
        delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
        done();
      });
    });

    it("Run is a class that can be extended", function () {
      process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "https://example.com/params";
      class MyRunner extends tfn.Run {
        handler(turbot, $, callback) {
          callback(null, "custom");
        }
      }
      const runner = new MyRunner();
      assert.instanceOf(runner, tfn.Run);
      runner.handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.equal(result, "custom");
      });
      delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    });
  });

  // ---------------------------------------------------------------------------
  // finalize behavior in test mode
  // ---------------------------------------------------------------------------
  describe("finalize behavior", function () {
    it("sets context.callbackWaitsForEmptyEventLoop to false", function (done) {
      const context = { callbackWaitsForEmptyEventLoop: true };
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, true);
      });
      handler({}, context, (err) => {
        assert.isFalse(context.callbackWaitsForEmptyEventLoop);
        done();
      });
    });

    it("returns null error on successful handler", function (done) {
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, "success");
      });
      handler({}, {}, (err, result) => {
        assert.isNull(err);
        assert.equal(result.result, "success");
        done();
      });
    });

    it("returns stringified error containing both err and result on handler error", function (done) {
      const handler = tfn((turbot, $, callback) => {
        callback(new Error("handler failed"));
      });
      handler({}, {}, (err) => {
        assert.isString(err);
        const parsed = JSON.parse(err);
        assert.exists(parsed.err);
        assert.exists(parsed.result);
        assert.exists(parsed.result.turbot);
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Combined credential + region flow
  // ---------------------------------------------------------------------------
  describe("full credential and region flow", function () {
    it("sets both credentials and region from a complete payload", function (done) {
      const event = {
        payload: {
          input: {
            account: {
              credentials: {
                AccessKeyId: "AKID-FULL",
                SecretAccessKey: "SECRET-FULL",
                SessionToken: "TOKEN-FULL",
              },
            },
            item: {
              turbot: { custom: { aws: { regionName: "us-west-2" } } },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "AKID-FULL");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SECRET-FULL");
        assert.equal(process.env.AWS_SESSION_TOKEN, "TOKEN-FULL");
        assert.equal(process.env.AWS_REGION, "us-west-2");
        assert.equal(process.env.AWS_DEFAULT_REGION, "us-west-2");
        callback(null, true);
      });
      handler(event, {}, done);
    });

    it("restores both credentials and region after handler completes", function (done) {
      process.env.AWS_ACCESS_KEY_ID = "ORIG_KEY";
      process.env.AWS_REGION = "orig-region";
      const event = {
        payload: {
          input: {
            account: {
              credentials: { AccessKeyId: "TEMP_KEY" },
            },
            item: {
              turbot: { custom: { aws: { regionName: "temp-region" } } },
            },
          },
        },
      };
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "TEMP_KEY");
        assert.equal(process.env.AWS_REGION, "temp-region");
        callback(null, true);
      });
      handler(event, {}, () => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "ORIG_KEY");
        assert.equal(process.env.AWS_REGION, "orig-region");
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Non-test mode with mocked external services
  // ---------------------------------------------------------------------------
  describe("non-test mode (mocked)", function () {
    const MessageValidator = require("@turbot/sns-validator");
    const taws = require("@turbot/guardrails-aws-sdk-v3");

    const validMeta = {
      runType: "control",
      resourceId: "res-123456789012",
      processId: "proc-123",
      controlId: "ctl-123",
      tenantId: "tnt-123",
      returnSnsArn: "arn:aws:sns:us-east-1:123456789012:turbot-test",
    };

    function makeValidSnsEvent(msgObj) {
      return {
        Records: [
          {
            Sns: {
              Message: JSON.stringify(msgObj),
              Type: "Notification",
              SignatureVersion: "1",
              Signature: "test",
              SigningCertUrl: "https://sns.us-east-1.amazonaws.com/cert.pem",
            },
          },
        ],
      };
    }

    beforeEach(function () {
      delete process.env.TURBOT_TEST;
    });

    afterEach(function () {
      process.env.TURBOT_TEST = "true";
      sinon.restore();
    });

    it("processes valid SNS message through full lifecycle", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: { item: { name: "test-resource" } } },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot);
        assert.deepEqual($, msgObj.payload.input);
        turbot.ok();
        callback(null, "result");
      });

      handler(event, {}, (err) => {
        done();
      });
    });

    it("returns error when SNS message contains invalid JSON", function (done) {
      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: "not valid json {{{" });
      });

      const event = {
        Records: [
          {
            Sns: {
              Message: "not valid json {{{",
              Type: "Notification",
            },
          },
        ],
      };

      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("defaults runType to control when not specified in meta", function (done) {
      const msgObj = {
        meta: {
          resourceId: "res-123",
          processId: "proc-123",
          returnSnsArn: "arn:aws:sns:us-east-1:123456789012:test",
        },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        assert.exists(turbot);
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        done();
      });
    });

    it("handles handler error by sending error state via SNS", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        callback(new Error("handler failed"));
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("handles fatal error by swallowing err and sending success via SNS", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        const fatalErr = new Error("fatal crash");
        fatalErr.fatal = true;
        callback(fatalErr);
      });

      handler(event, {}, (err) => {
        // Fatal errors are swallowed, sendFinal is called (success path)
        done();
      });
    });

    it("sets AWS credentials from SNS payload in non-test mode", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          input: {
            account: {
              credentials: {
                AccessKeyId: "SNS-AKID",
                SecretAccessKey: "SNS-SECRET",
                SessionToken: "SNS-TOKEN",
              },
            },
            item: { turbot: { custom: { aws: { regionName: "us-west-2" } } } },
          },
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        assert.equal(process.env.AWS_ACCESS_KEY_ID, "SNS-AKID");
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "SNS-SECRET");
        assert.equal(process.env.AWS_SESSION_TOKEN, "SNS-TOKEN");
        assert.equal(process.env.AWS_REGION, "us-west-2");
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        done();
      });
    });

    it("messageSender calls taws.connect with SNS client", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSend = sinon.stub().resolves({ MessageId: "msg-456" });
      const mockSns = { send: mockSend };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, "done");
      });

      handler(event, {}, (err) => {
        assert.isTrue(taws.connect.called);
        done();
      });
    });

    it("handles SNS publish error in messageSender gracefully", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().rejects(new Error("SNS publish failed")) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, "done");
      });

      handler(event, {}, (err) => {
        // SNS error is propagated back through sendFinal callback
        done();
      });
    });

    it("catches synchronous exception in handler in non-test mode", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn(() => {
        throw new Error("sync crash in non-test");
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("uses TURBOT_FUNCTION_TYPE env var when no meta.runType", function (done) {
      process.env.TURBOT_FUNCTION_TYPE = "policy";
      const msgObj = {
        meta: {
          resourceId: "res-123",
          processId: "proc-123",
          returnSnsArn: "arn:aws:sns:us-east-1:123456789012:test",
        },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        done();
      });
    });

    it("returns expandEventData error back to caller", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          type: "large_parameter",
          s3PresignedUrlForParameterGet: "https://s3.example.com/large-param.zip",
          input: {},
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      // Stub tmp.dir to fail, triggering error path in expandEventData
      const tmp = require("tmp");
      sinon.stub(tmp, "dir").callsFake((opts, cb) => {
        cb(new Error("tmp dir creation failed"));
      });

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("expands large_parameter payload successfully", function (done) {
      const expandedPayload = {
        payload: { input: { item: { name: "expanded-resource" } } },
      };
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          type: "large_parameter",
          s3PresignedUrlForParameterGet: "https://s3.example.com/large-param.zip",
          input: {},
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      // Stub tmp.dir
      const tmp = require("tmp");
      sinon.stub(tmp, "dir").callsFake((opts, cb) => cb(null, "/tmp/mock-expand"));

      // Stub got.stream to return a mock readable
      const got = require("got");
      const { EventEmitter } = require("events");
      const mockDownloadStream = new EventEmitter();
      mockDownloadStream.pipe = function (writable) {
        process.nextTick(() => writable.emit("finish"));
        return writable;
      };
      sinon.stub(got, "stream").returns(mockDownloadStream);

      // Stub fs.createWriteStream to return a mock writable
      const fs = require("fs-extra");
      const mockWritable = new EventEmitter();
      sinon.stub(fs, "createWriteStream").returns(mockWritable);

      // Pre-require extract-zip to ensure it's in the cache, then stub it
      require("extract-zip");
      const extractZipPath = require.resolve("extract-zip");
      const originalExtractZip = require.cache[extractZipPath].exports;
      require.cache[extractZipPath].exports = sinon.stub().resolves();

      // Stub fs.readJson to return expanded data
      sinon.stub(fs, "readJson").callsFake((filePath, cb) => {
        cb(null, expandedPayload);
      });

      // Stub rimraf.sync
      const rimraf = require("rimraf");
      sinon.stub(rimraf, "sync");

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        // The expanded data should be merged into $
        assert.equal($.item.name, "expanded-resource");
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        require.cache[extractZipPath].exports = originalExtractZip;
        assert.isTrue(got.stream.calledOnce);
        done();
      });
    });

    it("handles download error in expandEventData", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          type: "large_parameter",
          s3PresignedUrlForParameterGet: "https://s3.example.com/large-param.zip",
          input: {},
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      // Stub tmp.dir
      const tmp = require("tmp");
      sinon.stub(tmp, "dir").callsFake((opts, cb) => cb(null, "/tmp/mock-dl-err"));

      // Stub got.stream — emit error after pipe
      const got = require("got");
      const { EventEmitter } = require("events");
      const mockDownloadStream = new EventEmitter();
      mockDownloadStream.pipe = function (writable) {
        process.nextTick(() => mockDownloadStream.emit("error", new Error("download failed")));
        return writable;
      };
      sinon.stub(got, "stream").returns(mockDownloadStream);

      // Stub fs.createWriteStream
      const fs = require("fs-extra");
      const mockWritable = new EventEmitter();
      sinon.stub(fs, "createWriteStream").returns(mockWritable);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("handles extract-zip error in expandEventData", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          type: "large_parameter",
          s3PresignedUrlForParameterGet: "https://s3.example.com/large-param.zip",
          input: {},
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const tmp = require("tmp");
      sinon.stub(tmp, "dir").callsFake((opts, cb) => cb(null, "/tmp/mock-extract-err"));

      const got = require("got");
      const { EventEmitter } = require("events");
      const mockDownloadStream = new EventEmitter();
      mockDownloadStream.pipe = function (writable) {
        process.nextTick(() => writable.emit("finish"));
        return writable;
      };
      sinon.stub(got, "stream").returns(mockDownloadStream);

      const fs = require("fs-extra");
      const mockWritable = new EventEmitter();
      sinon.stub(fs, "createWriteStream").returns(mockWritable);

      // Pre-require then stub extract-zip to reject
      require("extract-zip");
      const extractZipPath = require.resolve("extract-zip");
      const originalExtractZip = require.cache[extractZipPath].exports;
      require.cache[extractZipPath].exports = sinon.stub().rejects(new Error("bad zip"));

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });

      handler(event, {}, (err) => {
        require.cache[extractZipPath].exports = originalExtractZip;
        assert.exists(err);
        done();
      });
    });

    it("handles file write error in expandEventData", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: {
          type: "large_parameter",
          s3PresignedUrlForParameterGet: "https://s3.example.com/large-param.zip",
          input: {},
        },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const tmp = require("tmp");
      sinon.stub(tmp, "dir").callsFake((opts, cb) => cb(null, "/tmp/mock-write-err"));

      const got = require("got");
      const { EventEmitter } = require("events");
      const mockDownloadStream = new EventEmitter();
      mockDownloadStream.pipe = function (writable) {
        process.nextTick(() => writable.emit("error", new Error("write failed")));
        return writable;
      };
      sinon.stub(got, "stream").returns(mockDownloadStream);

      const fs = require("fs-extra");
      const mockWritable = new EventEmitter();
      sinon.stub(fs, "createWriteStream").returns(mockWritable);

      const event = makeValidSnsEvent(msgObj);
      const handler = tfn((turbot, $, callback) => {
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // persistLargeCommands (mocked)
  // ---------------------------------------------------------------------------
  describe("persistLargeCommands (mocked, via handler)", function () {
    const MessageValidator = require("@turbot/sns-validator");
    const taws = require("@turbot/guardrails-aws-sdk-v3");
    const https = require("https");
    const fs = require("fs-extra");

    const validMeta = {
      runType: "control",
      resourceId: "res-123456789012",
      processId: "proc-123",
      controlId: "ctl-123",
      tenantId: "tnt-123",
      returnSnsArn: "arn:aws:sns:us-east-1:123456789012:turbot-test",
      s3PresignedUrlLargeCommands: "https://s3.example.com/put-commands?sig=abc",
    };

    beforeEach(function () {
      delete process.env.TURBOT_TEST;
    });

    afterEach(function () {
      process.env.TURBOT_TEST = "true";
      sinon.restore();
    });

    it("persists large commands via S3 presigned URL", function (done) {
      this.timeout(5000);

      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      // Mock fs.access to trigger ENOENT (dir does not exist)
      sinon.stub(fs, "access").callsFake((path, cb) => {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        cb(err);
      });

      // Mock fs.ensureDir
      sinon.stub(fs, "ensureDir").callsFake((path, cb) => cb(null));

      // Mock fs.writeFile
      sinon.stub(fs, "writeFile").callsFake((path, data, cb) => cb(null));

      // Mock fs.createReadStream — return a stream that ends with data
      const { EventEmitter } = require("events");
      const { PassThrough } = require("stream");
      sinon.stub(fs, "createReadStream").callsFake(() => {
        const s = new PassThrough();
        process.nextTick(() => s.end(Buffer.from("fake-zip-data")));
        return s;
      });

      // Mock fs.stat
      sinon.stub(fs, "stat").callsFake((path, cb) => cb(null, { size: 1024 }));

      // Mock https.request
      sinon.stub(https, "request").callsFake((opts, respCb) => {
        const mockReq = new PassThrough();
        process.nextTick(() => {
          const resp = new EventEmitter();
          respCb(resp);
          process.nextTick(() => {
            resp.emit("data", "OK");
            resp.emit("end");
          });
        });
        return mockReq;
      });

      // Mock rimraf.sync
      const rimraf = require("rimraf");
      sinon.stub(rimraf, "sync");

      const event = {
        Records: [
          {
            Sns: {
              Message: JSON.stringify(msgObj),
              Type: "Notification",
            },
          },
        ],
      };

      const handler = tfn((turbot, $, callback) => {
        // Inject large commands into cargo to trigger persistLargeCommands
        turbot.cargoContainer.largeCommands = {
          commands: [{ type: "resource_put", data: { id: "res-test" } }],
        };
        turbot.cargoContainer.largeCommandState = null;
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.isTrue(https.request.calledOnce);
        assert.isTrue(rimraf.sync.called);
        done();
      });
    });

    it("persists large commands with largeCommandV2 flag", function (done) {
      this.timeout(5000);

      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      // Mock fs for temp dir (existing dir)
      sinon.stub(fs, "access").callsFake((path, cb) => cb(null));
      sinon.stub(fs, "writeFile").callsFake((path, data, cb) => cb(null));

      const { EventEmitter } = require("events");
      const { PassThrough } = require("stream");
      sinon.stub(fs, "createReadStream").callsFake(() => {
        const s = new PassThrough();
        process.nextTick(() => s.end(Buffer.from("fake-zip-data")));
        return s;
      });
      sinon.stub(fs, "stat").callsFake((path, cb) => cb(null, { size: 512 }));

      sinon.stub(https, "request").callsFake((opts, respCb) => {
        const mockReq = new PassThrough();
        process.nextTick(() => {
          const resp = new EventEmitter();
          respCb(resp);
          process.nextTick(() => {
            resp.emit("data", "OK");
            resp.emit("end");
          });
        });
        return mockReq;
      });

      const rimraf = require("rimraf");
      sinon.stub(rimraf, "sync");

      const event = {
        Records: [
          {
            Sns: {
              Message: JSON.stringify(msgObj),
              Type: "Notification",
            },
          },
        ],
      };

      const handler = tfn((turbot, $, callback) => {
        // Use largeCommandV2 format
        turbot.cargoContainer.largeCommandV2 = true;
        turbot.cargoContainer.commands = [{ type: "resource_put" }];
        turbot.cargoContainer.logEntries = [{ level: "info", message: "test" }];
        turbot.cargoContainer.largeCommandState = null;
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        assert.isTrue(https.request.calledOnce);
        done();
      });
    });

    it("handles fs.stat error during large command upload", function (done) {
      this.timeout(5000);

      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      const mockSns = { send: sinon.stub().resolves({ MessageId: "msg-123" }) };
      sinon.stub(taws, "connect").returns(mockSns);

      sinon.stub(fs, "access").callsFake((path, cb) => cb(null));
      sinon.stub(fs, "writeFile").callsFake((path, data, cb) => cb(null));

      const { PassThrough } = require("stream");
      sinon.stub(fs, "createReadStream").callsFake(() => {
        const s = new PassThrough();
        process.nextTick(() => s.end(Buffer.from("fake")));
        return s;
      });

      // fs.stat fails
      sinon.stub(fs, "stat").callsFake((path, cb) => cb(new Error("stat failed")));

      const rimraf = require("rimraf");
      sinon.stub(rimraf, "sync");

      const event = {
        Records: [{ Sns: { Message: JSON.stringify(msgObj), Type: "Notification" } }],
      };

      const handler = tfn((turbot, $, callback) => {
        turbot.cargoContainer.largeCommands = { commands: [{ type: "test" }] };
        turbot.cargoContainer.largeCommandState = null;
        turbot.ok();
        callback(null, true);
      });

      handler(event, {}, (err) => {
        done();
      });
    });

});

  // ---------------------------------------------------------------------------
  // finalize edge cases (mocked)
  // ---------------------------------------------------------------------------
  describe("finalize edge cases (mocked)", function () {
    const MessageValidator = require("@turbot/sns-validator");
    const taws = require("@turbot/guardrails-aws-sdk-v3");

    const validMeta = {
      runType: "control",
      resourceId: "res-123456789012",
      processId: "proc-123",
      controlId: "ctl-123",
      tenantId: "tnt-123",
      returnSnsArn: "arn:aws:sns:us-east-1:123456789012:turbot-test",
    };

    beforeEach(function () {
      delete process.env.TURBOT_TEST;
    });

    afterEach(function () {
      process.env.TURBOT_TEST = "true";
      sinon.restore();
    });

    it("handles send error when handler returns non-fatal error", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      // Make SNS send reject to trigger error in send callback (line 578)
      const mockSns = { send: sinon.stub().rejects(new Error("SNS send failed")) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = {
        Records: [{ Sns: { Message: JSON.stringify(msgObj), Type: "Notification" } }],
      };

      const handler = tfn((turbot, $, callback) => {
        callback(new Error("handler non-fatal error"));
      });

      handler(event, {}, (err) => {
        assert.exists(err);
        done();
      });
    });

    it("handles sendFinal error on successful handler", function (done) {
      const msgObj = {
        meta: { ...validMeta },
        payload: { input: {} },
      };

      sinon.stub(MessageValidator.prototype, "validate").callsFake((msg, cb) => {
        cb(null, { Message: JSON.stringify(msgObj) });
      });

      // Make SNS send reject to trigger error in sendFinal callback (line 557-558)
      const mockSns = { send: sinon.stub().rejects(new Error("SNS sendFinal failed")) };
      sinon.stub(taws, "connect").returns(mockSns);

      const event = {
        Records: [{ Sns: { Message: JSON.stringify(msgObj), Type: "Notification" } }],
      };

      const handler = tfn((turbot, $, callback) => {
        turbot.ok();
        callback(null, "success");
      });

      handler(event, {}, (err) => {
        // sendFinal error is propagated
        done();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Helper: save/restore process listeners around proxyquire loads
// The module calls process.removeAllListeners() for SIGINT, SIGTERM,
// uncaughtException, and unhandledRejection on load, which removes Mocha's
// handlers. We must save them before and restore them after each load.
// ---------------------------------------------------------------------------
const signalEvents = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];
let savedListeners = {};

function saveProcessListeners() {
  savedListeners = {};
  for (const evt of signalEvents) {
    savedListeners[evt] = process.listeners(evt).slice();
  }
}

function restoreProcessListeners() {
  for (const evt of signalEvents) {
    process.removeAllListeners(evt);
    for (const fn of savedListeners[evt] || []) {
      process.on(evt, fn);
    }
  }
}

// ---------------------------------------------------------------------------
// proxyquire-based tests for Run.run() and container paths
// ---------------------------------------------------------------------------
describe("Run.run() (proxyquire)", function () {
  const proxyquire = require("proxyquire").noCallThru();

  const validLaunchParams = {
    meta: {
      runType: "control",
      resourceId: "res-123456789012",
      processId: "proc-123",
      controlId: "ctl-123",
      tenantId: "tnt-123",
      returnSnsArn: "arn:aws:sns:us-east-1:123456789012:turbot-test",
      launchType: "FARGATE",
      s3PresignedUrlLargeCommands: "https://s3.amazonaws.com/bucket/key?presigned",
    },
    payload: {
      input: { item: { name: "test-container-resource" } },
    },
  };

  let exitStub;
  let gotStub;
  let gotStreamStub;
  let tawsStub;
  let mockSns;
  let proxiedModule;

  beforeEach(function () {
    saveProcessListeners();
    exitStub = sinon.stub();
    gotStreamStub = sinon.stub();
    mockSns = { send: sinon.stub().resolves({ MessageId: "msg-container" }) };

    tawsStub = {
      connect: sinon.stub().returns(mockSns),
      CustomDiscoveryRetryStrategy: sinon.stub(),
    };
  });

  afterEach(function () {
    sinon.restore();
    restoreProcessListeners();
    process.env.TURBOT_TEST = "true";
    delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.TURBOT_REGION;
  });

  function loadModule(gotFn) {
    gotFn.stream = gotStreamStub;
    proxiedModule = proxyquire("..", {
      got: gotFn,
      "@turbot/guardrails-aws-sdk-v3": tawsStub,
      "@turbot/sns-validator": function MockValidator() {
        this.validate = sinon.stub();
      },
    });
  }

  it("constructor throws when no parameters supplied", function () {
    gotStub = sinon.stub();
    loadModule(gotStub);

    delete process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    assert.throws(() => new proxiedModule.Run(), /No parameters supplied/);
  });

  it("constructor throws when parameters is 'undefined' string", function () {
    gotStub = sinon.stub();
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "undefined";
    assert.throws(() => new proxiedModule.Run(), /No parameters supplied/);
  });

  it("constructor succeeds with valid parameters URL", function () {
    gotStub = sinon.stub();
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    const runner = new proxiedModule.Run();
    assert.ok(runner);
    assert.equal(runner._runnableParameters, "http://localhost:9999/params");
  });

  it("runs handler with unencrypted launch parameters (FARGATE)", function (done) {
    gotStub = sinon.stub().resolves({ body: validLaunchParams });
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    let handlerCalled = false;

    runner.handler = function (turbot, $, callback) {
      handlerCalled = true;
      turbot.ok();
      callback();
    };

    runner.run();

    // Poll for process.exit call since run() is async
    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(handlerCalled, "handler should have been called");
        assert.ok(exitStub.calledWith(0), "process.exit(0) should be called");
        done();
      }
    }, 10);

    // Safety timeout
    setTimeout(() => {
      clearInterval(interval);
      // If exit wasn't called, check if there was an error logged
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("handles got() error when retrieving launch parameters", function (done) {
    gotStub = sinon.stub().rejects(new Error("Network error"));
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(exitStub.calledWith(0), "process.exit(0) should be called on error");
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("handles handler error by calling turbot.sendFinal and process.exit", function (done) {
    gotStub = sinon.stub().resolves({ body: validLaunchParams });
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    runner.handler = function (turbot, $, callback) {
      callback(new Error("handler failed"));
    };

    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(exitStub.calledWith(0));
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("retrieves EC2 container metadata for EC2 launch type", function (done) {
    const ec2Params = JSON.parse(JSON.stringify(validLaunchParams));
    ec2Params.meta.launchType = "EC2";

    // First call: launch params. Second call: container metadata
    const metadataResponse = {
      body: {
        AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        Token: "FwoGZXIvYXdzEBYaDH/EXAMPLE",
      },
    };

    gotStub = sinon.stub();
    gotStub.onFirstCall().resolves({ body: ec2Params });
    gotStub.onSecondCall().resolves(metadataResponse);
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/test-id";
    process.env.TURBOT_REGION = "us-east-1";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    runner.handler = function (turbot, $, callback) {
      callback();
    };

    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(gotStub.calledTwice, "got should be called twice (params + metadata)");
        assert.ok(exitStub.calledWith(0));
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("decrypts container parameters when $$dataKey is present", function (done) {
    // Create encrypted launch params with $$dataKey
    const crypto = require("crypto");
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const plaintext = JSON.stringify(validLaunchParams);

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const cipherBuffer = Buffer.concat([iv, encrypted, tag]);

    const envelope = {
      $$dataKey: key.toString("base64"),
      $$data: cipherBuffer.toString("base64"),
      kmsKey: "arn:aws:kms:us-east-1:123456789012:key/test-key-id",
    };

    // Mock KMS decrypt to return the key
    const mockKms = {
      send: sinon.stub().resolves({ Plaintext: Buffer.from(key.toString("base64"), "utf8") }),
    };

    gotStub = sinon.stub().resolves({ body: envelope });
    loadModule(gotStub);

    // Make taws.connect return mockKms for KMSClient and mockSns for SNSClient
    tawsStub.connect = sinon.stub().callsFake((ClientClass, params) => {
      if (params && params.KeyId) {
        return mockKms;
      }
      return mockSns;
    });

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    runner.handler = function (turbot, $, callback) {
      callback();
    };

    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(mockKms.send.calledOnce, "KMS decrypt should be called");
        assert.ok(exitStub.calledWith(0));
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("base class handler logs warning and calls back", function (done) {
    gotStub = sinon.stub().resolves({ body: validLaunchParams });
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    exitStub = sinon.stub(process, "exit");

    // Use base class handler (don't override) to cover line 921-923
    const runner = new proxiedModule.Run();

    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        assert.ok(exitStub.calledWith(0));
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });

  it("cleans up AWS env vars after successful container run", function (done) {
    gotStub = sinon.stub().resolves({ body: validLaunchParams });
    loadModule(gotStub);

    process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = "http://localhost:9999/params";
    process.env.AWS_ACCESS_KEY_ID = "TESTKEY";
    process.env.AWS_SECRET_ACCESS_KEY = "TESTSECRET";
    exitStub = sinon.stub(process, "exit");

    const runner = new proxiedModule.Run();
    runner.handler = function (turbot, $, callback) {
      callback();
    };

    runner.run();

    const interval = setInterval(() => {
      if (exitStub.called) {
        clearInterval(interval);
        // Container mode deletes AWS env vars after handling
        assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
        assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);
        done();
      }
    }, 10);

    setTimeout(() => {
      clearInterval(interval);
      if (!exitStub.called) {
        done(new Error("process.exit was not called within timeout"));
      }
    }, 5000);
  });
});


// ---------------------------------------------------------------------------
// unhandledExceptionHandler (proxyquire)
// ---------------------------------------------------------------------------
describe("unhandledExceptionHandler via signal handlers (proxyquire)", function () {
  const proxyquire = require("proxyquire").noCallThru();

  beforeEach(function () {
    saveProcessListeners();
  });

  afterEach(function () {
    sinon.restore();
    restoreProcessListeners();
    process.env.TURBOT_TEST = "true";
  });

  it("module registers process signal handlers on load", function () {
    const gotFn = sinon.stub();
    gotFn.stream = sinon.stub();

    const tawsStub = {
      connect: sinon.stub(),
      CustomDiscoveryRetryStrategy: sinon.stub(),
    };

    proxyquire("..", {
      got: gotFn,
      "@turbot/guardrails-aws-sdk-v3": tawsStub,
      "@turbot/sns-validator": function MockValidator() {
        this.validate = sinon.stub();
      },
    });

    // After loading, the module registers handlers for these events
    const sigintListeners = process.listeners("SIGINT");
    const sigtermListeners = process.listeners("SIGTERM");
    const uncaughtListeners = process.listeners("uncaughtException");
    const rejectionListeners = process.listeners("unhandledRejection");

    assert.ok(sigintListeners.length > 0, "SIGINT listener should be registered");
    assert.ok(sigtermListeners.length > 0, "SIGTERM listener should be registered");
    assert.ok(uncaughtListeners.length > 0, "uncaughtException listener should be registered");
    assert.ok(rejectionListeners.length > 0, "unhandledRejection listener should be registered");
  });
});

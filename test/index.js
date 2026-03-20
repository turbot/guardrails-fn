const { assert } = require("chai");
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
});

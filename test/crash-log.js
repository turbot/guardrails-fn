const http = require("http");
const util = require("util");
const MessageValidator = require("@turbot/sns-validator");
const { SNSClient } = require("@aws-sdk/client-sns");
const { expect } = require("chai");

const tfn = require("..");

// The run's credentials, as Turbot puts them in a control's input. Each value is unique so a test can look for it in
// everything the function printed.
const CREDENTIALS = {
  accessKeyId: "AKIACRASHLOGTEST0001",
  secretAccessKey: "crash-log-test-secret-access-key",
  sessionToken: "crash-log-test-session-token",
};

const META = {
  resourceId: "resource-123",
  processId: "process-456",
  controlId: "control-789",
  tenantId: "tenant.example.com",
  returnSnsArn: "arn:aws:sns:us-east-1:123456789012:turbot-commands",
};

const input = () => ({ account: { credentials: { ...CREDENTIALS } }, item: { name: "bucket" } });

// An SNS-delivered Lambda event, the way Turbot starts a control: the run's input is inside the Message string.
const snsEvent = () => ({
  Records: [
    { Sns: { MessageId: "sns-message-1", Message: JSON.stringify({ meta: META, payload: { input: input() } }) } },
  ],
});

// The environment variables setAWSEnvVars writes. The run restores them only when it cached a value first, so a
// test puts back what was there before.
const ENV_VARS = [
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "TURBOT_CONTROL_CONTAINER_PARAMETERS",
];

// Records every line written through console while a test runs, formatted as console would print it.
const CONSOLE_METHODS = ["log", "error", "warn", "info", "debug"];
const captureConsole = () => {
  const lines = [];
  const originals = {};
  for (const method of CONSOLE_METHODS) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(util.format(...args));
  }
  return {
    lines,
    restore: () => {
      for (const method of CONSOLE_METHODS) {
        console[method] = originals[method];
      }
    },
  };
};

// Fails if any captured line holds one of the run's credentials, naming the line without printing the secret.
const expectNoCredentials = (lines) => {
  for (const [i, line] of lines.entries()) {
    for (const [name, secret] of Object.entries(CREDENTIALS)) {
      expect(line.includes(secret), `console line ${i} holds the ${name}`).to.equal(false);
    }
  }
};

// Finds the JSON log entry @turbot/log printed with this message.
const entryFor = (lines, message) => {
  const entries = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter((entry) => entry && entry.message === message);
  expect(entries, `a log entry "${message}"`).to.have.lengthOf(1);
  return entries[0];
};

// Runs the assertions and ends the test with their outcome, with the console put back first so a failure shows.
const settle = (done, capture, assertions) => {
  capture.restore();
  try {
    assertions();
  } catch (e) {
    return done(e);
  }
  return done();
};

describe("a handler crash in the log", function () {
  this.timeout(5000);

  let savedEnv, originalValidate, originalSend, capture;

  beforeEach(function () {
    savedEnv = {};
    for (const name of ENV_VARS) {
      savedEnv[name] = process.env[name];
    }
    originalValidate = MessageValidator.prototype.validate;
    originalSend = SNSClient.prototype.send;
    // Accept the hand-built SNS event without checking its signature, and publish the run's result nowhere.
    MessageValidator.prototype.validate = (hash, cb) => cb(null, hash);
    SNSClient.prototype.send = async () => ({ MessageId: "published-1" });
  });

  afterEach(function () {
    if (capture) {
      capture.restore();
      capture = null;
    }
    MessageValidator.prototype.validate = originalValidate;
    SNSClient.prototype.send = originalSend;
    for (const name of ENV_VARS) {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    }
  });

  describe("Lambda, started by SNS", function () {
    it("reports a handler that throws by its failure and run, with none of the run's credentials", function (done) {
      capture = captureConsole();
      const wrappedFn = tfn(() => {
        throw new Error("control blew up");
      });
      wrappedFn(snsEvent(), {}, (err) => {
        settle(done, capture, () => {
          expect(err).to.be.an("error");
          expect(err.message).to.equal("control blew up");
          expectNoCredentials(capture.lines);

          const entry = entryFor(capture.lines, "Caught exception while executing the handler");
          expect(entry.level).to.equal("error");
          expect(entry.error.message).to.equal("control blew up");
          expect(entry).to.include({
            resourceId: META.resourceId,
            processId: META.processId,
            controlId: META.controlId,
            tenant: META.tenantId,
          });
          expect(entry).to.not.have.any.keys("event", "context", "$");
        });
      });
    });

    it("prints none of the run's credentials when an async handler throws", function (done) {
      capture = captureConsole();
      const wrappedFn = tfn.fnAsync(async () => {
        throw new Error("async control blew up");
      });
      wrappedFn(snsEvent(), {}, (err) => {
        settle(done, capture, () => {
          expect(err).to.be.an("error");
          expect(err.message).to.equal("async control blew up");
          expect(capture.lines.join("\n")).to.include("Received message");
          expectNoCredentials(capture.lines);
        });
      });
    });

    it("prints none of the run's credentials when the handler throws a value that is not an Error", function (done) {
      capture = captureConsole();
      const wrappedFn = tfn(() => {
        throw "plain string failure";
      });
      wrappedFn(snsEvent(), {}, () => {
        settle(done, capture, () => {
          expectNoCredentials(capture.lines);
          const entry = entryFor(capture.lines, "Caught exception while executing the handler");
          expect(entry.error).to.equal("plain string failure");
          expect(entry.controlId).to.equal(META.controlId);
        });
      });
    });
  });

  describe("Lambda, in test mode", function () {
    before(function () {
      process.env.TURBOT_TEST = true;
    });
    after(function () {
      delete process.env.TURBOT_TEST;
    });

    it("reports a handler that throws by its failure and run, with none of the run's credentials", function (done) {
      capture = captureConsole();
      const wrappedFn = tfn(() => {
        throw new Error("control blew up in test mode");
      });
      // In test mode the event carries the input itself, credentials and all.
      wrappedFn({ meta: META, payload: { input: input() } }, {}, () => {
        settle(done, capture, () => {
          expectNoCredentials(capture.lines);
          const entry = entryFor(capture.lines, "Caught exception while executing the handler");
          expect(entry.error.message).to.equal("control blew up in test mode");
          expect(entry).to.include({
            resourceId: META.resourceId,
            processId: META.processId,
            controlId: META.controlId,
          });
        });
      });
    });
  });

  describe("container", function () {
    let server, originalExit;

    beforeEach(function (done) {
      originalExit = process.exit;
      server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ meta: { ...META, launchType: "FARGATE" }, payload: { input: input() } }));
      });
      server.listen(0, "127.0.0.1", () => {
        process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS = `http://127.0.0.1:${server.address().port}/parameters`;
        done();
      });
    });

    afterEach(function (done) {
      process.exit = originalExit;
      server.close(done);
    });

    it("reports a handler that fails by its failure and run, with none of the run's credentials", function (done) {
      class FailingRun extends tfn.Run {
        handler(turbot, $, callback) {
          return callback(new Error("container control blew up"));
        }
      }
      capture = captureConsole();
      // A container run ends the process once it has sent its result; the exit is the end of the test.
      process.exit = () =>
        settle(done, capture, () => {
          expectNoCredentials(capture.lines);
          const entry = entryFor(capture.lines, "Error while running");
          expect(entry.error.message).to.equal("container control blew up");
          expect(entry).to.include({
            resourceId: META.resourceId,
            processId: META.processId,
            controlId: META.controlId,
          });
          expect(entry).to.not.have.any.keys("results");
        });
      new FailingRun().run();
    });
  });
});

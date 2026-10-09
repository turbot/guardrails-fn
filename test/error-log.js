const { Readable } = require("stream");
const { expect } = require("chai");
const { KMSClient, ListKeysCommand } = require("@aws-sdk/client-kms");

const tfn = require("..");

// Builds the error aws-sdk v2 produces for a JSON-protocol response whose body has a type but no message
// (lib/protocol/json.js extractError, then lib/util.js error).
const sdkV2Error = ({ fatal }) => {
  const err = new Error();
  err.message = null;
  err.code = "InternalFailure";
  err["[__type]"] = "See error.__type for details.";
  Object.defineProperty(err, "__type", { value: "com.amazonaws#InternalFailure", enumerable: false, writable: true });
  Object.defineProperty(err, "name", { writable: true, enumerable: false });
  Object.defineProperty(err, "message", { enumerable: true });
  err.name = "InternalFailure";
  err.time = new Date();
  err.requestId = "abc-123";
  err.statusCode = 500;
  err.retryable = true;
  err.fatal = fatal;
  return err;
};

// Gets the error aws-sdk v3 rejects with when KMS answers with status 500 and the given JSON body. The error comes
// from smithy's real error path, not built by hand.
const sdkV3Error = async (body, { fatal }) => {
  const kms = new KMSClient({
    region: "us-east-1",
    maxAttempts: 1,
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
    requestHandler: {
      handle: async () => ({
        response: {
          statusCode: 500,
          headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": "abc-123" },
          body: Readable.from([Buffer.from(JSON.stringify(body))]),
        },
      }),
    },
  });
  const err = await kms.send(new ListKeysCommand({})).then(
    () => expect.fail("ListKeys should have failed"),
    (e) => e
  );
  err.fatal = fatal;
  return err;
};

// Runs a handler that calls back with err and returns the process event. In test mode the whole run is synchronous.
const run = (err) => {
  let output;
  tfn((turbot, $, callback) => callback(err))({}, {}, (lambdaErr, result) => {
    output = lambdaErr ? JSON.parse(lambdaErr).result : result;
  });
  return output.turbot.payload;
};

describe("handler error log", function () {
  before(function () {
    process.env.TURBOT_TEST = true;
  });
  after(function () {
    delete process.env.TURBOT_TEST;
  });

  for (const fatal of [false, true]) {
    describe(fatal ? "fatal" : "non-fatal", function () {
      it("logs an SDK error with no message as its code, status and request", function () {
        const [entry, stackEntry] = run(sdkV2Error({ fatal })).log;

        expect(entry.level).to.equal("error");
        expect(entry.data.error).to.deep.include({
          message: "InternalFailure (HTTP 500, request abc-123)",
          code: "InternalFailure",
          statusCode: 500,
          requestId: "abc-123",
          retryable: true,
          fatal,
        });
        expect(entry.data.error).to.not.have.any.keys("[__type]", "__type", "stack");
        expect(entry.data.mode).to.equal("lambda");

        expect(stackEntry.level).to.equal("debug");
        expect(stackEntry.data.stack).to.match(/^InternalFailure: null\n/);
      });

      it("logs an aws-sdk v3 error with no message as its name, status and request", async function () {
        const err = await sdkV3Error({ __type: "com.amazonaws#InternalFailure" }, { fatal });
        expect(err.message).to.equal("UnknownError");

        const [entry] = run(err).log;

        expect(entry.level).to.equal("error");
        expect(entry.data.error).to.deep.include({
          message: "InternalFailure (HTTP 500, request abc-123)",
          name: "InternalFailure",
          statusCode: 500,
          requestId: "abc-123",
          fatal,
        });
      });

      it("keeps the message of an aws-sdk v3 error whose body has one, and still logs its status and request", async function () {
        const err = await sdkV3Error(
          { __type: "com.amazonaws#KMSInternalException", message: "Key is unavailable" },
          { fatal }
        );

        const [entry] = run(err).log;

        expect(entry.data.error).to.deep.include({
          message: "Key is unavailable",
          statusCode: 500,
          requestId: "abc-123",
        });
      });

      it("keeps a message of UnknownError on an error that isn't from aws-sdk v3", function () {
        const err = new Error("UnknownError");
        err.fatal = fatal;

        const [entry] = run(err).log;

        expect(entry.data.error.message).to.equal("UnknownError");
        expect(entry.data.error).to.not.have.any.keys("statusCode", "requestId");
      });

      it("keeps a message the error already has", function () {
        const err = new Error("User is not authorized to perform glue:GetDevEndpoints");
        err.fatal = fatal;

        const [entry] = run(err).log;

        expect(entry.data.error.message).to.equal(err.message);
      });
    });
  }

  it("sets the control state to error with the built message as its reason", function () {
    const [command] = run(sdkV2Error({ fatal: true })).commands;

    expect(command.type).to.equal("control_update");
    expect(command.payload.state).to.equal("error");
    expect(command.payload.reason).to.equal("InternalFailure (HTTP 500, request abc-123)");
    expect(command.payload.data.error.code).to.equal("InternalFailure");
  });

  it("sets the control state to error with the built message of an aws-sdk v3 error as its reason", async function () {
    const err = await sdkV3Error({ __type: "com.amazonaws#InternalFailure" }, { fatal: true });

    const [command] = run(err).commands;

    expect(command.type).to.equal("control_update");
    expect(command.payload.state).to.equal("error");
    expect(command.payload.reason).to.equal("InternalFailure (HTTP 500, request abc-123)");
  });

  it("logs an error that isn't an object unchanged", function () {
    const [entry] = run("Something went wrong").log;

    expect(entry.data.error).to.equal("Something went wrong");
  });
});

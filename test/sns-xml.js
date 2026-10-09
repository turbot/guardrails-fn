const { expect } = require("chai");
const http = require("http");

const taws = require("@turbot/guardrails-aws-sdk-v3");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

// tfn publishes its commands with SNS, whose replies are XML. These tests send a Publish through the same
// taws.connect(SNSClient, …) that tfn uses, to a local server that answers like SNS, so a change to how the SDK
// parses XML has to keep reading both a successful reply and an error reply.

const TOPIC = "arn:aws:sns:us-east-1:123456789012:turbot-commands";

// Starts a server on a free local port that answers every request with the given status and XML body, and keeps
// what it was sent.
const startServer = (status, xml) =>
  new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, body: new URLSearchParams(body) });
        res.writeHead(status, { "Content-Type": "text/xml" });
        res.end(xml);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });

const snsFor = (port) =>
  taws.connect(SNSClient, {
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" },
  });

describe("SNS replies parsed by the AWS SDK", function () {
  this.timeout(10000);

  let local;
  afterEach(function (done) {
    if (!local) {
      return done();
    }
    local.server.close(done);
    local = null;
  });

  it("reads the message ID of a successful publish", async function () {
    local = await startServer(
      200,
      `<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <PublishResult>
    <MessageId>567910cd-659e-55d4-8ccb-5aaf14679dc0</MessageId>
  </PublishResult>
  <ResponseMetadata>
    <RequestId>d74b8436-ae13-5ab4-a9ff-ce54dfea72a0</RequestId>
  </ResponseMetadata>
</PublishResponse>`
    );

    const result = await snsFor(local.port).send(new PublishCommand({ TopicArn: TOPIC, Message: '{"type":"ok"}' }));

    expect(result.MessageId).to.equal("567910cd-659e-55d4-8ccb-5aaf14679dc0");
    expect(local.requests).to.have.length(1);
    expect(local.requests[0].body.get("Action")).to.equal("Publish");
    expect(local.requests[0].body.get("TopicArn")).to.equal(TOPIC);
    expect(local.requests[0].body.get("Message")).to.equal('{"type":"ok"}');
  });

  it("turns an SNS error reply into an error with its code and decoded message", async function () {
    local = await startServer(
      403,
      `<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <Error>
    <Type>Sender</Type>
    <Code>AuthorizationError</Code>
    <Message>User: arn:aws:iam::123456789012:user/ci is not authorized to perform: SNS:Publish on resource: ${TOPIC} &amp; &lt;policy&gt; &quot;deny&quot;</Message>
  </Error>
  <RequestId>9e7e8d4f-2b0c-5b4e-9a63-6a0d3e1f2c11</RequestId>
</ErrorResponse>`
    );

    let caught;
    try {
      await snsFor(local.port).send(new PublishCommand({ TopicArn: TOPIC, Message: "{}" }));
    } catch (err) {
      caught = err;
    }

    expect(caught, "the publish should have failed").to.be.an("error");
    // The SDK names the error after the modelled exception; the parsed body keeps the code SNS sent.
    expect(caught.name).to.equal("AuthorizationErrorException");
    expect(caught.Error).to.include({ Type: "Sender", Code: "AuthorizationError" });
    expect(caught.message).to.equal(
      `User: arn:aws:iam::123456789012:user/ci is not authorized to perform: SNS:Publish on resource: ${TOPIC} & <policy> "deny"`
    );
    expect(caught.$fault).to.equal("client");
    expect(caught.$metadata.httpStatusCode).to.equal(403);
    expect(caught.RequestId).to.equal("9e7e8d4f-2b0c-5b4e-9a63-6a0d3e1f2c11");
  });
});

const crypto = require("crypto");
const fs = require("fs-extra");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { expect } = require("chai");

const turbotLog = require("@turbot/log");
const { Turbot } = require("@turbot/sdk");
const tfn = require("..");

// Waits for an event, failing after a deadline rather than hanging the suite.
const waitFor = (emitter, event, what, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

describe("large command upload", function () {
  this.timeout(15000);

  const originals = {};
  let tmpDir, server, port, opened, uploads;

  // Runs a handler whose cargo holds large commands, so the run uploads them before it finishes. The commands are
  // random, so the zip stays about 1 MB: the upload then waits on the socket while the zip is still open.
  const run = (presignedUrl = "https://large-commands.test/upload?sig=1", onTurbot = () => {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the run to finish")), 10000);
      const event = {
        meta: { s3PresignedUrlLargeCommands: presignedUrl, processId: "p-24" },
      };
      tfn((turbot, $, callback) => {
        onTurbot(turbot);
        turbot.cargoContainer.largeCommands = {
          commands: [{ data: crypto.randomBytes(768 * 1024).toString("base64") }],
        };
        callback(null, true);
      })(event, {}, (err) => {
        clearTimeout(timer);
        resolve(err);
      });
    });

  const startServer = (onRequest) =>
    new Promise((resolve) => {
      server = http.createServer(onRequest);
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });

  // Each zip the upload opened must close, which releases its file descriptor.
  const expectZipsClosed = async () => {
    for (const stream of opened) {
      if (!stream.closed) {
        await waitFor(stream, "close", "the large command zip to close");
      }
      expect(stream.destroyed).to.equal(true);
    }
  };

  before(function () {
    process.env.TURBOT_TEST = true;
  });
  after(function () {
    delete process.env.TURBOT_TEST;
  });

  beforeEach(async function () {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guardrails-fn-large-commands-"));
    originals.tmpDir = process.env.TURBOT_TMP_DIR;
    process.env.TURBOT_TMP_DIR = tmpDir;

    opened = [];
    uploads = [];
    originals.createReadStream = fs.createReadStream;
    fs.createReadStream = (...args) => {
      const stream = originals.createReadStream(...args);
      opened.push(stream);
      return stream;
    };

    // Send the upload to a local plain-HTTP server in place of S3. Only the address and TLS change: the request,
    // its socket and the zip stream behave as they do against S3.
    originals.httpsRequest = https.request;
    https.request = (options, callback) => {
      uploads.push(options);
      return http.request({ ...options, host: "127.0.0.1", port }, callback);
    };
  });

  afterEach(async function () {
    fs.createReadStream = originals.createReadStream;
    https.request = originals.httpsRequest;
    fs.stat = originals.stat || fs.stat;
    delete originals.stat;
    if (originals.tmpDir === undefined) {
      delete process.env.TURBOT_TMP_DIR;
    } else {
      process.env.TURBOT_TMP_DIR = originals.tmpDir;
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    await fs.remove(tmpDir);
  });

  it("uploads the zip and closes it", async function () {
    let received = 0;
    await startServer((req, res) => {
      req.on("data", (chunk) => (received += chunk.length));
      req.on("end", () => res.end("ok"));
    });

    const err = await run();

    expect(err).to.equal(null);
    expect(uploads).to.have.lengthOf(1);
    expect(uploads[0].method).to.equal("PUT");
    expect(received).to.be.above(512 * 1024);
    expect(received).to.equal(uploads[0].headers["content-length"]);
    expect(opened).to.have.lengthOf(1);
    await expectZipsClosed();
  });

  it("closes the zip when the upload request fails", async function () {
    let resets = 0;
    await startServer((req) => {
      resets += 1;
      req.socket.destroy();
    });

    await run();

    expect(resets).to.equal(1);
    expect(opened).to.have.lengthOf(1);
    await expectZipsClosed();
  });

  it("leaves no zip open when stat fails", async function () {
    await startServer(() => expect.fail("nothing should be uploaded"));
    originals.stat = fs.stat;
    fs.stat = (file, callback) => callback(Object.assign(new Error(`EACCES: stat ${file}`), { code: "EACCES" }));

    await run();

    expect(uploads).to.have.lengthOf(0);
    await expectZipsClosed();
  });

  it("ends the upload and finishes the run when the zip cannot be read", async function () {
    await startServer((req, res) => req.resume().on("end", () => res.end("ok")));
    // A directory opens but fails on its first read (EISDIR).
    fs.createReadStream = () => {
      const stream = originals.createReadStream(tmpDir);
      opened.push(stream);
      return stream;
    };

    await run();

    expect(opened).to.have.lengthOf(1);
    await expectZipsClosed();
  });

  describe("logging", function () {
    const signedUrl =
      "https://large-commands.test/bucket/key.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef1234";

    // Records everything the upload logs: through the module logger, and through the run's process log (turbot.log
    // is a getter that builds a new object each time, so the process log is caught where it is written).
    const recordLogs = () => {
      const entries = [];
      const originalLogger = Turbot.prototype._logger;
      Turbot.prototype._logger = function (...args) {
        entries.push(JSON.stringify(args));
        return originalLogger.apply(this, args);
      };
      const originals = {};
      ["info", "debug"].forEach((method) => {
        originals[method] = turbotLog[method];
        turbotLog[method] = (...args) => {
          entries.push(JSON.stringify(args));
          return originals[method].apply(turbotLog, args);
        };
      });
      return {
        entries,
        restore: () => {
          Turbot.prototype._logger = originalLogger;
          ["info", "debug"].forEach((method) => (turbotLog[method] = originals[method]));
        },
      };
    };

    it("does not log the presigned URL's query string, but still sends it", async function () {
      await startServer((req, res) => req.resume().on("end", () => res.end("ok")));
      const logs = recordLogs();

      try {
        const err = await run(signedUrl);
        expect(err).to.equal(null);
      } finally {
        logs.restore();
      }

      // The request still carries the signature, or S3 would refuse it.
      expect(uploads).to.have.lengthOf(1);
      expect(uploads[0].path).to.equal("/bucket/key.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef1234");

      // The path is logged, in both the module log and the process log, without the signature.
      const logged = logs.entries.filter((entry) => entry.includes("/bucket/key.zip"));
      expect(logged.some((entry) => entry.includes('"Saving large command with options"'))).to.equal(true);
      expect(logged.some((entry) => entry.includes('"Options to put large commands"'))).to.equal(true);
      logs.entries.forEach((entry) => {
        expect(entry).to.not.include("X-Amz-Signature");
        expect(entry).to.not.include("deadbeef1234");
      });
    });
  });
});

const http = require("http");
const os = require("os");
const path = require("path");
const asyncjs = require("async");
const fs = require("fs-extra");
const got = require("got");
const tmp = require("tmp");
const archiver = require("archiver");
const MessageValidator = require("@turbot/sns-validator");
const { expect } = require("chai");

const tfn = require("..");

// Builds a zip holding large-input.json, the way Turbot stores a large parameter in S3.
const largeParameterZip = (largeInput) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip");
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.append(JSON.stringify(largeInput), { name: "large-input.json" });
    archive.finalize();
  });
};

// An SNS-delivered Lambda event whose payload is a large parameter to be downloaded from the given URL.
const largeParameterEvent = (url) => {
  const msgObj = { meta: {}, payload: { type: "large_parameter", s3PresignedUrlForParameterGet: url } };
  return { Records: [{ Sns: { Message: JSON.stringify(msgObj) } }] };
};

// Waits for an emitter's event, failing if it does not come within a second.
const waitFor = (emitter, event, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} was not closed`)), 1000);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

// Runs the assertions and ends the test with their outcome. A throw must not escape: index.js turns an uncaught
// exception into a process exit.
const settle = (done, assertions) => {
  try {
    assertions();
  } catch (e) {
    return done(e);
  }
  return done();
};

describe("expandEventData large parameter download", function () {
  let server, baseUrl, respond;
  let originalValidate, originalAuto, originalTmpDir;
  let downloadCallbackArgs, tmpDirs;
  let downloadStream, file, onDownload;
  const originalStream = got.stream;
  const originalCreateWriteStream = fs.createWriteStream;

  before(function (done) {
    // Accept the hand-built SNS event without checking its signature.
    originalValidate = MessageValidator.prototype.validate;
    MessageValidator.prototype.validate = (hash, cb) => cb(null, hash);

    // Record what the download task hands to its async.auto callback.
    originalAuto = asyncjs.auto;
    asyncjs.auto = (tasks, ...rest) => {
      const spec = tasks.downloadLargeParameterZip;
      if (spec) {
        const task = spec[spec.length - 1];
        const recorded = (results, cb) => {
          tmpDirs.push(results.tmpDir);
          return task(results, (...args) => {
            downloadCallbackArgs.push(args);
            return cb(...args);
          });
        };
        tasks = { ...tasks, downloadLargeParameterZip: [...spec.slice(0, -1), recorded] };
      }
      return originalAuto(tasks, ...rest);
    };

    originalTmpDir = tmp.dir;

    server = http.createServer((req, res) => respond(req, res));
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after(function (done) {
    MessageValidator.prototype.validate = originalValidate;
    asyncjs.auto = originalAuto;
    server.closeAllConnections();
    server.close(done);
  });

  beforeEach(function () {
    downloadCallbackArgs = [];
    tmpDirs = [];

    // Spy on the two streams expandEventData opens, so a test can see whether they were closed.
    downloadStream = undefined;
    file = undefined;
    onDownload = () => {};
    got.stream = (...args) => {
      downloadStream = originalStream(...args);
      onDownload();
      return downloadStream;
    };
    fs.createWriteStream = (...args) => {
      file = originalCreateWriteStream(...args);
      return file;
    };
    respond = (req, res) => {
      res.statusCode = 404;
      res.end();
    };
  });

  afterEach(function () {
    // Close a download a failed test left open, so it does not fail later into a callback already called.
    if (downloadStream && !downloadStream.destroyed) {
      downloadStream.destroy();
    }
    got.stream = originalStream;
    fs.createWriteStream = originalCreateWriteStream;
    tmp.dir = originalTmpDir;
    for (const dir of tmpDirs) {
      fs.removeSync(dir);
    }
  });

  it("passes only the error to the callback when the download fails", function (done) {
    respond = (req, res) => {
      res.statusCode = 404;
      res.end("Not Found");
    };
    const wrappedFn = tfn(() => done(new Error("handler should not run when the download fails")));
    wrappedFn(largeParameterEvent(`${baseUrl}/large-parameter.zip`), {}, (err) => {
      settle(done, () => {
        expect(err).to.be.an("error");
        expect(err.response.statusCode).to.equal(404);
        expect(downloadCallbackArgs).to.have.lengthOf(1);
        expect(downloadCallbackArgs[0]).to.deep.equal([err]);
      });
    });
  });

  it("passes only the error to the callback when the file cannot be written", function (done) {
    respond = (req, res) => {
      res.statusCode = 200;
      res.end("never written");
    };
    // A temp dir that does not exist, so the write stream fails to open the file.
    const missingDir = path.join(os.tmpdir(), `turbot-fn-missing-${process.pid}`, "missing");
    tmp.dir = (opts, cb) => cb(null, missingDir);
    const wrappedFn = tfn(() => done(new Error("handler should not run when the file write fails")));
    wrappedFn(largeParameterEvent(`${baseUrl}/large-parameter.zip`), {}, (err) => {
      settle(done, () => {
        expect(err).to.be.an("error");
        expect(err.code).to.equal("ENOENT");
        expect(downloadCallbackArgs).to.have.lengthOf(1);
        expect(downloadCallbackArgs[0]).to.deep.equal([err]);
      });
    });
  });

  it("passes the downloaded file to the callback and expands the input", function (done) {
    largeParameterZip({ payload: { input: { fromLargeParameter: true } } })
      .then((zip) => {
        respond = (req, res) => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/zip");
          res.end(zip);
        };
        // The handler is the end of the test: returning from it without calling back keeps the run from
        // publishing its result to SNS.
        const wrappedFn = tfn((turbot, $) => {
          turbot.stop();
          settle(done, () => {
            expect($).to.deep.equal({ fromLargeParameter: true });
            expect(downloadCallbackArgs).to.have.lengthOf(1);
            const [err, fileName] = downloadCallbackArgs[0];
            expect(err).to.equal(null);
            expect(path.basename(fileName)).to.equal("large-parameter.zip");
          });
        });
        wrappedFn(largeParameterEvent(`${baseUrl}/large-parameter.zip`), {}, (err) => done(err || new Error("ended")));
      })
      .catch(done);
  });

  it("closes the file write stream when the download fails", function (done) {
    respond = (req, res) => {
      // Promise more than is sent, then drop the connection mid-body.
      res.writeHead(200, { "content-type": "application/zip", "content-length": 1000 });
      res.write(Buffer.alloc(10));
      setTimeout(() => req.socket.destroy(), 50);
    };
    const wrappedFn = tfn(() => done(new Error("handler should not run when the download fails")));
    wrappedFn(largeParameterEvent(`${baseUrl}/large-parameter.zip`), {}, (err) => {
      try {
        expect(err).to.be.an("error");
        expect(downloadCallbackArgs).to.deep.equal([[err]]);
        expect(downloadStream.destroyed).to.equal(true);
        expect(file.destroyed).to.equal(true);
      } catch (e) {
        return done(e);
      }
      (file.closed ? Promise.resolve() : waitFor(file, "close", "the file write stream")).then(() => done(), done);
    });
  });

  it("destroys the download stream when writing the file fails", function (done) {
    let serverSocketClosed;
    respond = (req, res) => {
      serverSocketClosed = waitFor(req.socket, "close", "the download connection");
      res.writeHead(200, { "content-type": "application/zip", "content-length": 1000 });
      res.write(Buffer.alloc(10));
    };
    // Fail the write once the download is under way, the way a full disk does mid-download.
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    onDownload = () => downloadStream.once("response", () => file.destroy(diskFull));
    const wrappedFn = tfn(() => done(new Error("handler should not run when the file write fails")));
    wrappedFn(largeParameterEvent(`${baseUrl}/large-parameter.zip`), {}, (err) => {
      try {
        expect(err.code).to.equal("ENOSPC");
        expect(downloadCallbackArgs).to.deep.equal([[err]]);
        expect(downloadStream.destroyed).to.equal(true);
        // The server sees the client drop the connection, so the socket is not left open.
        expect(serverSocketClosed).to.exist;
      } catch (e) {
        return done(e);
      }
      serverSocketClosed.then(() => done(), done);
    });
  });
});

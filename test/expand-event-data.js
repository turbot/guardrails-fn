const http = require("http");
const os = require("os");
const path = require("path");
const asyncjs = require("async");
const fs = require("fs-extra");
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
    respond = (req, res) => {
      res.statusCode = 404;
      res.end();
    };
  });

  afterEach(function () {
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
});

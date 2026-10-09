const http = require("http");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const fs = require("fs-extra");
const got = require("got");
const streamBuffers = require("stream-buffers");

const tfn = require("..");

// Waits for an emitter's event, failing the test if it does not come within a second.
const waitFor = (emitter, event, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} was not closed`)), 1000);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

// Builds a zip holding large-input.json with the given content, the way the server packs a large parameter.
const largeParameterZip = (content) =>
  new Promise((resolve, reject) => {
    const archiver = require("archiver");
    const out = new streamBuffers.WritableStreamBuffer();
    const archive = archiver("zip");
    out.on("finish", () => resolve(out.getContents()));
    archive.on("error", reject);
    archive.pipe(out);
    archive.append(JSON.stringify(content), { name: "large-input.json" });
    archive.finalize();
  });

const expand = (msgObj) =>
  new Promise((resolve) => tfn._expandEventData(msgObj, (err, result) => resolve({ err, result })));

describe("expandEventData", function () {
  let server;
  let respond;
  let url;
  let downloadStream;
  let file;
  let onDownload;
  let tmpRoot;
  const originalTmpDir = process.env.TMPDIR;
  const originalStream = got.stream;
  const originalCreateWriteStream = fs.createWriteStream;

  beforeEach(async function () {
    // expandEventData keeps its tmp dir when it fails, so give each test its own root and remove it afterwards.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "expand-event-data-"));
    process.env.TMPDIR = tmpRoot;

    server = http.createServer((req, res) => respond(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/large-parameter.zip`;

    // Spy on the two streams expandEventData opens, so a test can see whether they were closed.
    downloadStream = undefined;
    file = undefined;
    onDownload = () => {};
    got.stream = (...args) => {
      downloadStream = originalStream(...args);
      onDownload();
      return downloadStream;
    };
    fs.createWriteStream = (p, ...rest) => {
      file = originalCreateWriteStream(p, ...rest);
      return file;
    };
  });

  afterEach(async function () {
    // Close a download a failed test left open, quietly, so dropping the server's connections below does not
    // make it fail into a callback that has already been called.
    if (downloadStream && !downloadStream.destroyed) {
      downloadStream.destroy();
    }
    if (originalTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpDir;
    }
    fs.removeSync(tmpRoot);
    got.stream = originalStream;
    fs.createWriteStream = originalCreateWriteStream;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const msgObj = () => ({
    payload: { type: "large_parameter", s3PresignedUrlForParameterGet: url },
  });

  it("downloads, extracts and merges the large parameter, then closes the file", async function () {
    const zip = await largeParameterZip({ payload: { input: { bucket: "a-bucket" } } });
    respond = (req, res) => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length });
      res.end(zip);
    };

    const { err, result } = await expand(msgObj());

    expect(err).to.not.exist;
    expect(result.payload.input).to.deep.equal({ bucket: "a-bucket" });
    if (!file.closed) {
      await waitFor(file, "close", "the file write stream");
    }
  });

  it("closes the file write stream when the download fails", async function () {
    respond = (req, res) => {
      // Promise more than is sent, then drop the connection mid-body.
      res.writeHead(200, { "content-type": "application/zip", "content-length": 1000 });
      res.write(Buffer.alloc(10));
      setTimeout(() => req.socket.destroy(), 50);
    };

    const { err } = await expand(msgObj());

    expect(err).to.exist;
    expect(downloadStream.destroyed).to.equal(true);
    expect(file.destroyed).to.equal(true);
    if (!file.closed) {
      await waitFor(file, "close", "the file write stream");
    }
    expect(file.closed).to.equal(true);
  });

  it("destroys the download stream when writing the file fails", async function () {
    let serverSocketClosed;
    respond = (req, res) => {
      serverSocketClosed = waitFor(req.socket, "close", "the download connection");
      res.writeHead(200, { "content-type": "application/zip", "content-length": 1000 });
      res.write(Buffer.alloc(10));
    };
    // Fail the write once the download is under way, the way a full disk does mid-download.
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    onDownload = () => downloadStream.once("response", () => file.destroy(diskFull));

    const { err } = await expand(msgObj());

    expect(err).to.equal(diskFull);
    expect(downloadStream.destroyed).to.equal(true);
    // The server sees the client drop the connection, so the socket is not left open.
    expect(serverSocketClosed).to.exist;
    await serverSocketClosed;
  });
});

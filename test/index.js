const { assert, expect } = require("chai");

const tfn = require("..");

describe("@turbot/fn", function () {
  before(function () {
    process.env.TURBOT_TEST = true;
  });
  after(function () {
    delete process.env.TURBOT_TEST;
  });
  it("has turbot variable", function (done) {
    const wrappedFn = tfn((turbot, $, callback) => {
      assert.exists(turbot);
      assert.isFunction(turbot.ok);
      assert.isFunction(turbot.resource.create);
      callback(null, true);
    });
    wrappedFn({}, {}, done);
  });

  it("turbot.ok works", function (done) {
    const wrappedFn = tfn((turbot, $, callback) => {
      turbot.ok();
      callback(null, true);
    });
    wrappedFn({}, {}, (err, output) => {
      if (err) return done(new Error(err));
      // In test mode the result carries the process event the handler sent back.
      const states = output.turbot.payload.commands.map((command) => command.payload.state);
      expect(states).to.deep.equal(["ok"]);
      return done();
    });
  });

  it("turbot.alarm does not set the state to ok", function (done) {
    const wrappedFn = tfn((turbot, $, callback) => {
      turbot.alarm();
      callback(null, true);
    });
    wrappedFn({}, {}, (err, output) => {
      if (err) return done(new Error(err));
      const states = output.turbot.payload.commands.map((command) => command.payload.state);
      expect(states).to.deep.equal(["alarm"]);
      return done();
    });
  });
});

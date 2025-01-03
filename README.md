# @turbot/guardrails-fn

Turbot wrapper for control functions.

## Install

    npm install --save @turbot/guardrails-fn

## Usage

This package returns a function with the signature expected by AWS Lambda for node. It should
be assigned to the handler entry point for the control.

    const tfn = require("@turbot/guardrails-fn");
    exports.control = tfn((turbot, $, callback) => {
      // your code here
    });

## Test mode

If `TURBOT_TEST` is truthy then the function will be run in test mode:

- Input should be passed directly (no SNS message wrapper)
- The callback results will be `{ turbot: {/*data*/}, result: {/*data*/} }`.
- Commands will not be published to SNS.

# Threat model

This file records what `@turbot/guardrails-fn` protects, where untrusted input crosses into it, and which control holds
each boundary. A change that removes or weakens a control below should say so in its PR, and update this file.

`test/threat-model.js` checks that this file names each boundary and that the functions it points at still exist in
`index.js`.

## What the package is

A wrapper for Turbot control functions. It runs either as an AWS Lambda handler fed by SNS, or as the entry point of a
container (`Run`). It receives a run's input, puts the run's AWS credentials in the process environment for the
control's code, runs the control, sends the commands the control produced back over SNS or S3, and clears the
credentials. It has no network listener of its own.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Per-run AWS credentials for managed accounts | The SNS message's `credentials` (organization, organizational unit or account), then `AWS_ACCESS_KEY*`, `AWS_SECRET_*`, `AWS_SESSION_TOKEN` and `AWS_SECURITY_TOKEN` in `process.env` | They act in a customer's AWS account. |
| Container role credentials | The ECS credentials endpoint (`http://169.254.170.2` + `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`), held in `_containerSnsParam` | They publish the run's result to SNS. |
| Presigned S3 URLs | `s3PresignedUrlForParameterGet` (read) and `s3PresignedUrl` (write) | The signature in the query string is the credential. Anyone holding the URL can use it until it expires. |
| The KMS data key and the decrypted container parameters | `envelope.$$dataKey` (KMS-encrypted) and `envelope.$$data` (AES-256-GCM) | The plaintext parameters can hold credentials and customer data. |
| The control's input and the commands it produces | The SNS message, the large-input zip, the large-commands zip | Customer resource data. |

## Boundaries and controls

### 1. The SNS message into `initialize`

Input: `event.Records[0].Sns`, which anyone who can reach the Lambda's invoke permission can forge.

- The message is verified with `@turbot/sns-validator` (AWS signature and certificate check) before its `Message` is
  parsed. A message that fails validation is rejected with `badRequest` and no credential is set.
- `TURBOT_TEST` skips the SNS wrapper and the validation: the event is trusted as given. It is an operator setting for
  local runs and tests. It must never be set on a deployed function, and nothing in a message can turn it on. With it
  set, commands are not published.

### 2. The presigned S3 GET zip into `expandEventData`

Input: `payload.s3PresignedUrlForParameterGet`, a URL taken from the (validated) message, for a `large_parameter` run.

- The zip is downloaded into a fresh `tmp` directory and extracted with `extract-zip`, which refuses entries that
  would land outside that directory.
- Only `large-input.json` is read from the extracted files. The directory is removed (`rimraf`) once the run has the
  data; on a failure it is left behind (`keep: true`).
- The URL is used as given. Turbot, which sends the message, is trusted to send a Turbot-issued URL, because the SNS
  message that carries it is signed.

### 3. The presigned S3 PUT in `persistLargeCommands`

Input: `meta.s3PresignedUrlLargeCommands` (passed on as `s3PresignedUrl`), where the run's large commands are written.
In Lambda it comes from the same signed message; in a container, from the parameters document (boundary 4).

- The only thing written is `large-commands.json`, zipped, with `content-length` taken from the file on disk.
- The upload is a single PUT to the host and path of the presigned URL. The file's descriptor is closed whichever
  way the upload ends.

### 4. The container parameters URL and KMS envelope (`Run`, `decryptContainerParameters`)

Input: `TURBOT_CONTROL_CONTAINER_PARAMETERS`, a URL in the container's environment, and the document it returns.

- The fetch has a 10 second timeout and expects JSON.
- When the document is an envelope (`$$dataKey`), the data key is decrypted by KMS with the encryption context
  `{ purpose: "turbot-control" }`, then the data is decrypted with AES-256-GCM. GCM checks the auth tag, so tampered
  data fails to decrypt instead of yielding wrong parameters. The IV is the first 12 bytes and the tag the last 16.
- A document without `$$dataKey` is used as it is. The container's environment is the trust boundary there.

### 5. The ECS credentials endpoint

- Read only for the `EC2` launch type, from the fixed link-local address `169.254.170.2`; the path comes from
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, which the platform sets and the container's code does not.
- The credentials go to `_containerSnsParam` and are used only to publish to SNS.

### 6. Credentials in `process.env`

`setAWSEnvVars` puts the run's credentials and region in the environment, because the control's AWS SDK calls read
them there. The process may be reused by Lambda for another run, so they must not outlive this one.

- Lambda: any value that was already set is cached, the run's values replace it, and `finalize` calls
  `restoreCachedAWSEnvVars` to delete the run's values and put the cached ones back.
- Container: `finalize` and `Run` delete the credential variables. Nothing is restored, because the container serves
  one run.
- `restoreCachedAWSEnvVars` clears the run's values only when something was cached, which holds in Lambda because the
  function's own execution-role credentials are always in the environment. A run that never reaches `finalize` (a
  killed process) does not clear them; in a container the process ends with the run.

### 7. Logs

- `@turbot/log` sanitizes each entry before it prints. It redacts by key name: `password`, `secretaccesskey`,
  `sessiontoken`, `token`, `key`, `privatekey` and the like, and anything starting with `$`. It does not look at
  values.
- `console.log` and `console.error` in `index.js` are not sanitized. They are used for the large-parameter download,
  the S3 and KMS failure paths and the handler crash path (see Known gaps).
- The control's `turbot.log` is cleaned by `@turbot/sdk`'s logger with the same sanitizer, and goes to the process
  log.

### 8. The fleet's own boundaries

This repo is worked by Agent Fleet, which runs agents with write access to a checkout.

- `.claude/settings.json` defines hooks that run commands on the worker. A change to it changes what runs on every
  agent's machine, so a PR that touches it needs a person's review of the hook commands.
- Dependabot security PRs carry the `agent:ready` label (`.github/dependabot.yml`), so the fleet picks them up and
  reviews them. A dependency bump is code that runs with the credentials in asset 1; the review reads the update, and
  `npm test` in CI must pass before it merges. A person merges (`agent:merge-by-hand`) where the PR says so.
- `npm publish` is on the fleet's `never_run` list. A release is published by a person.

## Known gaps

These are weaker than the controls above. They are recorded here so a review does not treat them as intended.

- Presigned URLs are logged in full. `expandEventData` writes `largeParameterZipUrl` with `console.error` on a failed
  download (unsanitized), and `persistLargeCommands` logs `reqOptions`, whose `path` holds the signed query string,
  through `log.info` (the sanitizer does not match a `path` value).
- When the control's handler throws, the catch in the handler wrapper calls `console.error` with the whole `event`.
  The SNS `Message` in it is a string holding the run's input, so the run's `accessKeyId`, `secretAccessKey` and
  `sessionToken` print in plain text: key-name redaction does not reach inside a string, and `console.error` is not
  sanitized at all. This is the most serious gap here.
- `expandEventData` logs the whole `msgObj` with `console.error` when it fails. It can hold the message body.
- On a failed `large_parameter` run the temporary directory is kept, with the downloaded zip in it, until the Lambda's
  storage is recycled.
- `@turbot/log` redacts by key name only. `accessKeyId` is not in its list.

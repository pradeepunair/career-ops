# Resume Lab

A local, draft-only companion for career-ops. Paste one job and your resume. Generate a tailored draft with your signed-in Codex CLI, inspect source evidence and gaps, edit it, and export HTML or Markdown. Use the browser's Print / Save PDF command for PDF output.

This trial has no employer integration, browser autofill, or application submission endpoint. It does not run the upstream installer or full career-ops pipeline. It reuses the upstream fact checker and writing checker.

## Run

1. Install Node.js 22 or later and the official Codex CLI.
2. Sign in to Codex with `codex login`.
3. From the repository root, run `node resume-lab/server.mjs`.
4. Open [the local page](http://127.0.0.1:4318).
5. Paste your resume, or put its text in the ignored `cv.md` file.
6. Paste a job description, or use the clearly labeled fictional example.
7. Select the input-sharing checkbox and generate the draft.
8. Review the facts and wording before enabling exports.

No `npm install` is required for this companion. It uses Node built-ins and existing upstream modules. `CODEX_BIN` can name the installed Codex executable. `RESUME_LAB_PORT` can select another local port. The model is `gpt-6.1-sol`; the account must have access to it. Model use is subject to the account's usage limits.

## Data and safety

- The page binds only to `127.0.0.1`. Requests need the expected Host and Origin. Mutating requests also need a random session token.
- Codex receives the pasted resume and job text. Processing uses OpenAI through your CLI login. Local hosting does not mean local inference.
- The worker runs read-only, with shell and web search tools disabled, in an empty temporary directory. It ignores user CLI configuration and project instruction files. No automatic permission bypass is used.
- Candidate facts come only from the source resume. Job text is treated as untrusted data. The worker returns structured text; the server writes the result.
- The UI inserts model text with text nodes, not model-authored HTML. Exported HTML blocks scripts and network access.
- The source `cv.md` and the last trial, `resume-lab/.local/trial.json`, are Git-ignored. The last trial contains private inputs and outputs. Keep it private. Temporary worker/check files are removed after each request. Browser inputs are not stored in localStorage.
- `--ephemeral` avoids normal Codex session persistence. It is not a promise about service-side retention or operating-system diagnostics. Your OpenAI account terms still apply.
- Checks flag unsupported metrics, some factual changes, missing bullet evidence, and unmatched quotes. They do not independently verify facts or prove that a quote supports a rewritten claim. Review dates, job titles, employer associations, scope, and metrics yourself.
- Editing a bullet can require restoring its source wording or regenerating its evidence. Exports remain disabled while blocking source findings exist.
- This tool makes no ATS score, hiring probability, human-authorship, or AI-detector bypass claim. PDF pagination and parser compatibility need review in the destination system.

## Review scope

Reviewed upstream commit: `96fa39b4a8973d27408413f060af9eea0b13c445`, on November 16, 2026.

The targeted review covered installer scripts, tailoring requests, privacy defaults, web origin/bind controls, application preparation, submit-control detection, PDF isolation, and fact/writing checks. It was not a full repository audit, dependency vulnerability audit, or execution test of every integration.

The upstream browser guard explicitly documents that an allowed button can submit through its own JavaScript handler. This companion omits browser automation. Upstream privacy filtering is configuration-dependent. Without a privacy configuration, pattern detection is off. The upstream root package has no npm lockfile at this commit; its installer runs dependency installation and a browser download. The companion does not run it.

## Verify

Run from the repository root:

```sh
node --test resume-lab/lab.test.mjs tests/headless-permission-flags.test.mjs
```

Tests cover bounded input, untrusted-input framing, unsupported metrics, quote verification, missing bullet evidence, origin/host checks, token enforcement, serial generation, and the absence of a submit endpoint. API tests use mock generation. A live one-job trial is a separate check.

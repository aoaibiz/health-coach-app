# Security Policy

We take the security of this project seriously. Thank you for helping keep it
and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately through GitHub's built-in private vulnerability
reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (Private vulnerability reporting).
3. Describe the issue, including steps to reproduce, affected versions, and any
   suggested remediation.

If private reporting is not enabled on a given fork, open a regular issue that
says only that you have found a security concern and would like a private
channel to disclose it — without including exploit details in the public issue.

Please include, where possible:

- A clear description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept.
- The affected component (`app/` frontend + Node server, or `api/` Cloudflare
  Worker) and version/commit.

## What to expect

- We aim to acknowledge a valid report promptly and to keep you updated on
  remediation progress.
- Please give us a reasonable amount of time to investigate and ship a fix
  before any public disclosure.

## Scope notes for self-hosters

This is a self-hostable application. Several security-relevant values are your
responsibility to provision and protect for your own deployment, including:

- OAuth credentials (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
- The Web Push VAPID keypair (`VAPID_PRIVATE_JWK` and the public key).
- The Node server's `HEALTH_APP_TOKEN`.
- Your Cloudflare D1 database id and account configuration.

These are injected as secrets/config at deploy time and must never be committed.
See `api/SECRETS.md`, `api/.dev.vars.example`, and `app/.env.example`.

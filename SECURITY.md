# Security

Saqme To Do handles access keys (the sync token in pairing links, the local app's key) and your lists, so
reports about anything that could expose or change them are very welcome.

## Reporting a problem

Please do **not** open a public issue. Use GitHub's private reporting instead: this repository's
**Security** tab, **Report a vulnerability**. Include what you found, how to reproduce it, and what an
attacker would need (a network position, a token, a local account on the same computer, ...). You will get
an answer within a week; fixes are published as soon as they are ready, with credit if you want it.

This is a small open-source project without a bug bounty.

## What is in scope

- The Worker (`worker/src`): authentication, the sync API, push subscriptions, the cron job.
- The phone app (`worker/public`): pairing, storage, content security policy, the copy on GitHub Pages.
- The desktop apps: the Windows widget and installer (`desktop/`, `scripts/setup.ps1`), the Linux/macOS app
  and its local server (`local/`, `scripts/setup.sh`), and the cloud setup (`scripts/cloud-setup.mjs`).

Your own Cloudflare account and the devices you pair are yours to protect: anyone with a pairing link (or
the token in it) can read and change your lists. `setup -RotateToken` (`--rotate-token`) replaces the key at
once; [docs/architecture.md](docs/architecture.md#security-notes) describes the design.

## Supported versions

Fixes go into the latest version on `main`; running setup again updates every part.

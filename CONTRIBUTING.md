# Contributing

Thanks for helping! Small, focused pull requests are easiest to review. Please open an issue first for
bigger changes.

## Layout

- `desktop/` — the Windows app (PowerShell 5.1 + WPF, no installs). `sync-core.ps1` is shared by the UI and
  the background sync loop.
- `local/` — the Linux/macOS app (Node.js 22.13+, no dependencies): the phone app in a window, served with
  the Worker's own code on SQLite, and `engine.mjs`, the JavaScript port of `desktop/sync-core.ps1`. A change
  to the sync engine's rules belongs in both (the end-to-end test runs them side by side).
- `worker/` — the Cloudflare Worker (`src/`) and the phone app it serves (`public/`), plain ES modules, no
  build step.
- `scripts/` — setup (`setup.ps1`, `setup.sh`, `cloud-setup.mjs`), the release build (`build-release.mjs`)
  and dev helpers (`scripts/dev/`).
- `shared/fixtures/` — input and expected output for every rule that exists both in PowerShell and in
  JavaScript (deadline parsing, reminders, the list format, order keys, value rules, the lists-folder
  engine, the updater's version and manifest rules). Both test suites run them; a rule changed on one side only fails the other side's suite. See
  [docs/architecture.md](docs/architecture.md#rules-that-exist-twice).
- `docs/` — user and design docs. If you change behaviour, update the matching page
  (especially [docs/sync.md](docs/sync.md) for anything that touches merging).
- `design/tokens.json` — colours, type scale, spacing and radii for both apps ([docs/design.md](docs/design.md)).
  After editing it run `node scripts/build-tokens.mjs`; it regenerates `worker/public/css/tokens.css` and
  `desktop/tokens.ps1`, and a test fails if they are stale, if a text colour drops below WCAG AA, or if
  `app.css`, the widget or the browser theme colours use a colour that is not from the tokens.
- `worker/public/fonts/` — FiraGO (SIL OFL 1.1), used by the phone app and loaded by the desktop app from
  the same files. `scripts/dev/subset-fonts.mjs` rebuilds the subsets.

## How to ship an update

Installed apps update themselves from this repository's GitHub Releases ([docs/setup.md](docs/setup.md#updating),
[docs/architecture.md](docs/architecture.md#updates)); a release is a tag, the workflow does the rest.

1. **The version** is written in one place, `version` in `worker/package.json` (the Worker, both apps, setup
   and the release read it from there; `worker/test/node/version.test.js` fails if it shows up anywhere else):

   ```bash
   cd worker && npm version 1.2.0 --no-git-tag-version   # package.json and package-lock.json together
   ```

2. **The notes:** a `## 1.2.0` section in `CHANGELOG.md` (rename `## Unreleased`). Its text becomes the
   release's description.
3. **Compatibility.** If the Worker gained something the apps now rely on, raise `API_VERSION` in
   `worker/src/version.js` and say what it is there and in [docs/sync.md](docs/sync.md#versions-and-updates).
   If the new apps cannot work with an older Worker at all, raise `MIN_WORKER_API` to that API: the updater
   then holds a computer's update until its Worker is updated (avoid it when you can; apps that say "your sync
   service is not updated yet" for one feature are better). A new database change goes in
   `worker/migrations/NNNN_name.sql` **and** `worker/src/migrations.js` (a test compares them); it must work on
   a database that already has every earlier migration, as the Worker applies it on its own.
4. **Commit, tag, push:**

   ```bash
   git commit -am "Release 1.2.0"
   git tag v1.2.0
   git push origin main v1.2.0
   ```

`.github/workflows/release.yml` then checks that the tag is the version in `worker/package.json`, runs the
tests, builds `saqme-1.2.0.zip`, the Worker's bundle `saqme-worker-1.2.0.bundle` (what a sync service that updates
itself deploys), their manifest `saqme-release.json` (version, API, `minWorkerApi`, sizes and SHA-256) and
`SHA256SUMS` with `scripts/build-release.mjs`, and publishes the release with them as *latest*. Apps see it within
a day (on start, then daily), Workers that update themselves within 6 hours. `node scripts/build-release.mjs --out /tmp/rel`
builds the same files locally to look at.

Once per repository: **Settings > Rules > Rulesets**, a tag ruleset for `v*` that restricts creation, update
and deletion to you (and requires the tests). Whoever can push such a tag ships code to every install (and to every Worker
given a token to update itself, which then holds that token): the updater checks the download against the release's checksum and only takes releases from this repository, but
it trusts what this repository publishes. Releases are not signed with a key of their own, on purpose: a key
in the Actions secrets protects nothing a tag rule does not, and one kept off GitHub would make every release
a manual step.

To try an update before publishing it: Windows, `scripts\dev\test-setup.ps1` installs, updates (from a release
it builds), refuses a bad checksum and rolls back a version that does not start, in a sandbox; Linux/macOS,
`worker/test/node/update.test.js` and `scripts/dev/test-setup-linux.sh`.

## Publishing the phone app

`.github/workflows/pages.yml` publishes `worker/public` to GitHub Pages on every push to `main` that touches
it (the copy for people without a Cloudflare account, docs/setup.md section 7). Once per repository:
**Settings > Pages > Build and deployment > Source: GitHub Actions**. Everyone using that copy runs what it
publishes, so protect `main` (required reviews) and keep the workflow's actions pinned to commits.

## Running and testing

```bash
cd worker
npm ci
npm test            # all Vitest tests (Node + workerd)
npm run test:e2e    # wrangler dev --local + two phones + the desktop engine (desktop part needs powershell.exe)
npm run dev         # local Worker + phone app on http://localhost:8787, prints a pairing link
node test/ui/pwa-ui-check.mjs   # optional: scripted touch walkthrough of the phone app, sharing a list with a fresh browser too (needs Playwright, see the file)
node test/ui/pwa-static-check.mjs   # optional: the app from a static host (sub-folder, export/import, offline, cross-origin pairing)
node test/ui/pwa-a11y-check.mjs     # optional: axe-core + keyboard / focus / zoom checks (needs axe-core too, see the file)
node test/ui/local-window-check.mjs # optional: the Linux/macOS window's Settings > Sync & sharing > Set up sync (Playwright)
node ../scripts/dev/screenshots.mjs --out ~/shots   # optional: phone screenshots with the sample lists (Playwright, see the file)
node ../scripts/dev/motion-shots.mjs --out ~/shots  # optional: frames of Settings moving (docs/design.md, "Motion")
node ../scripts/dev/readme-images.mjs --shots ~/shots   # optional: rebuilds docs/images (needs the desktop shot, see the file)
```

On Windows (or from WSL):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\sync-core.tests.ps1        # sync engine unit tests
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\shared-fixtures.tests.ps1  # shared/fixtures (Vitest runs them too)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-setup.ps1          # installer, in a sandbox
powershell -NoProfile -ExecutionPolicy Bypass -STA -File desktop\widget.ps1 -DataDir C:\temp\saqme-dev            # run the app on scratch data
powershell -NoProfile -ExecutionPolicy Bypass -STA -File desktop\widget.ps1 -DataDir C:\temp\saqme-x -SmokeTest   # headless self-check (no -DataDir: a temp folder; never the real data folder)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-shots.ps1 -Out C:\temp\shots              # renders the views to PNG
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\render-widget.ps1 -Out C:\temp\shots             # the README shots (sample lists)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\uia-check.ps1                                    # what screen readers see (UI Automation)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-files-check.ps1                             # the widget and other programs writing the same list
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\container-check.ps1                                # from a shell inside a Store app (Claude Desktop): the 2026-10-22 incident, reproduced and checked
```

Linux, macOS (or WSL):

```bash
node local/saqme.mjs open --data /tmp/saqme-dev      # run the Linux/macOS app on scratch data (any OS, Node.js 22.13+)
node local/saqme.mjs connect 'http://localhost:8787/#pair=<AUTH_TOKEN>' --data /tmp/saqme-dev   # sync it with npm run dev
scripts/dev/test-setup-linux.sh                       # setup.sh in Debian 10 / Ubuntu 20.04 / Fedora / CentOS 7 containers (Docker)
scripts/dev/test-setup-linux.sh ubuntu:18.04 alpine:3.20 alpine:3.22+node   # glibc 2.27, musl, a distribution's own Node.js
```

To try the desktop against your local Worker, put a `sync\config.json` into the scratch data folder:
`{"url":"http://localhost:8787","token":"<AUTH_TOKEN from worker/.dev.vars>","enabled":true}`.

Pull requests should keep all of these green. `.github/workflows/tests.yml` runs the Vitest suite and the
end-to-end test on Linux, and the PowerShell suites, the widget's self-check and the installer test on
Windows, for every pull request (no secrets needed). The browser checks under `test/ui` and the scripts in
`scripts/dev` that drive the widget are run by hand. Never commit `worker/wrangler.toml`, `.dev.vars` or
anything with a token in it.

## Style

- Match the surrounding code: short functions, comments that explain *why*, no new dependencies unless
  there is no reasonable alternative (and then pin the version).
- PowerShell 5.1 pitfalls worth knowing: variables are case-insensitive (`$s` and `$S` are the same),
  `Sort-Object` compares culture-aware (use `Sort-Ordinal` for order keys), `$null` passed to a .NET
  `string` parameter becomes `""` (use `[NullString]::Value`), and `-eq` on strings ignores case (use `-ceq`).
- The phone app must keep working offline and must never re-render under the user's finger: see
  `requestRender()` in `worker/public/js/app.js`.
- Sync changes need tests: unit tests for the rule, and the end-to-end run must still converge.

## The repository name (forks)

The repository the project is published from is set in one place: `repository` in `worker/package.json`.
The setup scripts run on their own from the web (`irm … | iex`, `curl … | bash`) and the docs are plain
markdown, so they spell it out too: the README's and docs/setup.md's one-line commands, `$Repo` in
`scripts/setup.ps1`, `REPO` in `scripts/setup.sh`, and the address of the phone app on GitHub Pages. To
publish a fork, run `node scripts/dev/set-repository.mjs <owner>/<name>`: it changes all of them.
`worker/test/node/repository.test.js` fails if any of them disagrees.

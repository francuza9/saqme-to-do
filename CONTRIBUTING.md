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
- `scripts/` — setup (`setup.ps1`, `setup.sh`, `cloud-setup.mjs`) and dev helpers (`scripts/dev/`).
- `shared/fixtures/` — input and expected output for every rule that exists both in PowerShell and in
  JavaScript (deadline parsing, reminders, the list format, order keys, value rules, the lists-folder
  engine). Both test suites run them; a rule changed on one side only fails the other side's suite. See
  [docs/architecture.md](docs/architecture.md#rules-that-exist-twice).
- `docs/` — user and design docs. If you change behaviour, update the matching page
  (especially [docs/sync.md](docs/sync.md) for anything that touches merging).
- `design/tokens.json` — colours, type scale, spacing and radii for both apps ([docs/design.md](docs/design.md)).
  After editing it run `node scripts/build-tokens.mjs`; it regenerates `worker/public/css/tokens.css` and
  `desktop/tokens.ps1`, and a test fails if they are stale, if a text colour drops below WCAG AA, or if
  `app.css`, the widget or the browser theme colours use a colour that is not from the tokens.
- `worker/public/fonts/` — FiraGO (SIL OFL 1.1), used by the phone app and loaded by the desktop app from
  the same files. `scripts/dev/subset-fonts.mjs` rebuilds the subsets.

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
node test/ui/pwa-ui-check.mjs   # optional: scripted touch walkthrough of the phone app (needs Playwright, see the file)
node test/ui/pwa-static-check.mjs   # optional: the app from a static host (sub-folder, export/import, offline, cross-origin pairing)
node test/ui/pwa-a11y-check.mjs     # optional: axe-core + keyboard / focus / zoom checks (needs axe-core too, see the file)
node test/ui/local-window-check.mjs # optional: the Linux/macOS window's Settings > Sync > Set up sync (Playwright)
node ../scripts/dev/screenshots.mjs --out ~/shots   # optional: phone screenshots with the sample lists (Playwright, see the file)
node ../scripts/dev/readme-images.mjs --shots ~/shots   # optional: rebuilds docs/images (needs the desktop shot, see the file)
```

On Windows (or from WSL):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\sync-core.tests.ps1        # sync engine unit tests
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\shared-fixtures.tests.ps1  # shared/fixtures (Vitest runs them too)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-setup.ps1          # installer, in a sandbox
powershell -NoProfile -ExecutionPolicy Bypass -STA -File desktop\widget.ps1 -DataDir C:\temp\saqme-dev            # run the app on scratch data
powershell -NoProfile -ExecutionPolicy Bypass -STA -File desktop\widget.ps1 -DataDir C:\temp\saqme-x -SmokeTest   # headless self-check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-shots.ps1 -Out C:\temp\shots              # renders the views to PNG
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\render-widget.ps1 -Out C:\temp\shots             # the README shots (sample lists)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\uia-check.ps1                                    # what screen readers see (UI Automation)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-files-check.ps1                             # the widget and other programs writing the same list
```

Linux, macOS (or WSL):

```bash
node local/saqme.mjs open --data /tmp/saqme-dev      # run the Linux/macOS app on scratch data (any OS, Node.js 22.13+)
node local/saqme.mjs connect 'http://localhost:8787/#pair=<AUTH_TOKEN>' --data /tmp/saqme-dev   # sync it with npm run dev
scripts/dev/test-setup-linux.sh                       # setup.sh in Debian 10 / Ubuntu 20.04 / Fedora containers (Docker)
scripts/dev/test-setup-linux.sh centos:7 alpine:3.20 alpine:3.22+node   # old glibc, musl, a distribution's own Node.js
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

# VelChat QA — Runbook

Practical answer to "kab konsa command chalana hai". Everything here is a plain `node`/`python`
script — no CI required to use it, though CI is described at the bottom for hands-off runs.

**Nobody runs this automatically for you.** Claude does not run in the background — these
commands execute only when you (or a CI job) invoke them. If you want the Excel/Jira report to
refresh on its own (nightly, or on every push), set up the GitHub Actions job in §6.

---

## 0. One-time setup

```bash
cd QA
cp config/qa.env.example config/qa.env   # if the example doesn't exist yet, see §1 below
```

Edit `QA/config/qa.env` (git-ignored — never commit it) with your Jira token and the backend URL
you want to test against. `QA/lib/env.js` loads it automatically; real environment variables
always win over the file.

## 1. Point the suite at a backend

Edit these three lines in `QA/config/qa.env`:

```bash
API_BASE_URL=http://localhost:8080      # or https://velchat.duckdns.org for prod
WS_BASE_URL=ws://localhost:8080/ws
QA_ALLOW_REMOTE_PROVISION=false         # true ONLY if you accept using the webhook auth-bypass
                                         # seam (VC-6/VC-39) against a non-local host you own
```

**Local backend** (safest — you own every account you create):
```bash
cd D:\Velchat && node tools/gateway/start-all.mjs
```
Wait for it to actually be ready — a bare `/health` 200 is not enough, the DB/Redis connections
take longer:
```bash
cd QA && npm run qa:env
```
If `qa:env` fails, the backend isn't ready yet (or has gone stale — see §5).

## 2. Run the tests

```bash
cd QA
npm run qa:env         # fails fast if the backend isn't reachable — never skip this
npm run qa:api         # auth + security REST tests
npm run qa:websocket   # realtime + two-device tests (slower — has deliberate waits)
npm run qa             # env + api + websocket, in order

# client-side (mobile repo) regression tests — defects encoded as failing-until-fixed tests
npm run qa:client
```

Every run appends to `QA/reports/results.jsonl` (append-only — never delete this file, the flaky
detector and the Excel report both need history). Set `QA_RUN_ID=my-label` before a run to tag it.

## 3. Build the Excel report

```bash
npm run qa:report
```

**Always the SAME file** — `QA/reports/VelChat-QA-Report.xlsx`. This never creates a second copy;
every run overwrites that one file in place.

**Your manual edits are safe.** Two columns are yours to hand-edit directly in Excel and they are
never silently overwritten by a later run:

- **Test Results sheet → Result column.** Type anything that isn't a bare `PASS`/`FAIL`/`BLOCKED`/
  `SKIPPED`/`FLAKY` — e.g. `PASS (manual - verified on OPPO CPH2643, video attached)` for an
  on-device flow no automated test covers (Notification Reply, background behaviour, etc.). That
  exact text is preserved on every future run, no matter what the automated suite reports.
- **Bugs sheet → Status column.** Same rule — type `Fixed (manually verified by <name>)` or
  similar and it sticks.

To hand a bug/test **back to automation**, clear the cell — the next `qa:report` repopulates it
from the live data.

If Excel has the file open when you run this, the script retries a couple of times and then tells
you plainly to close it — it will **never** write a second file as a workaround.

**Bug numbering never skips or reuses an id.** New bugs are always appended as the next number
(1–43 today → the next one is always 44, whether it comes from me finding it live or from you
adding one by hand with `node scripts/add-bug.mjs`). A bug already tracked never gets a duplicate
row — the same id always upserts into its existing row.

## 4. Sync bugs to Jira

```bash
npm run qa:jira:dry     # ALWAYS do this first — prints the exact payload, no network call, no creds needed
npm run qa:jira         # creates new issues, comments on existing ones (dedup by label qa-<bug-id>)
```

Safe to re-run as often as you like — it never creates a duplicate issue for the same bug id; a
repeat run adds a "still reproduces" comment instead. Only touches bugs whose `status` in
`bugs.json` is not `Closed`.

## 5. When a test run looks worse than last time

Before treating it as a regression, rule out an environment problem (§47 — this bit us once
already on 2026-09-11):

```bash
npm run qa:env
curl http://localhost:8080/auth/otp/send -X POST -H 'Content-Type: application/json' -d '{"phone":"+919911199999"}'
```

If that second call returns `500 {"message":"Connection is closed."}` while `/health` still says
`200`, the backend's DB/Redis pool has gone stale (this happens after it sits idle for hours) —
**restart it**, don't file a new bug:
```bash
cd D:\Velchat && node tools/gateway/start-all.mjs
```
Then poll `npm run qa:env` until it's clean before re-running tests.

## 6. Marking a bug Fixed

1. Re-run the covering test(s) named in `bugs.json` → `testIds` for that bug.
2. If **every** covering test now passes, open `QA/reports/bugs.json`, find the bug, set
   `"status": "Fixed"`, add `"fixedIn": "<version or commit>"`.
3. `npm run qa:jira` — the sync script will comment the fix confirmation on the existing issue
   (transition the Jira issue to Done yourself; the script does not change workflow status).
4. `npm run qa:report` — the bug now shows up in the **Regression** sheet, guarded by its test.
5. **Never** hand-mark a bug fixed without re-running its test. "The backend restarted cleanly" or
   "it looks fixed in the code" is not verification — an actual PASS from the covering test is.

## 7. Two-device chat tests, in plain terms

`QA/tests/websocket/two-device.test.js` drives TWO real accounts (real tokens, real sockets)
through the real backend — this is a genuine two-party test, not one device pretending to be two.
It does **not** touch the on-device Android notification UI or background execution — that needs
Maestro (§8) or two physical phones, per `QA/DEVICE-MATRIX.md`.

## 8. Frontend (Maestro) E2E — separate track

```bash
export PATH="$HOME/.maestro/bin:$PATH"    # after the one-time install
adb devices                                # confirm a device/emulator is attached
maestro test QA/maestro/auth/welcome-to-signin.yaml
```

See `QA/maestro/README.md` for the flow catalogue and the exact selector limitations (most screens
have no `testID` yet — see `QA/_audit/`).

## 9. Google Sheets two-way sync (optional)

Keeps the local Excel report and a live Google Sheet mirroring each other. A manual edit made in
**either one** (Result column in Test Results, Status column in Bugs) propagates to the other — it
is never silently overwritten by the automated data on either side. See
`QA/scripts/sync/bridge.mjs` for exactly how that's decided.

### One-time setup (you do this part — needs your Google account)

1. https://console.cloud.google.com/ → **New Project** → any name (e.g. `velchat-qa`).
2. In that project, search **"Google Sheets API"** → **Enable**.
3. **IAM & Admin → Service Accounts → Create Service Account** → any name → Done (no roles needed).
4. Open it → **Keys** tab → **Add Key → Create new key → JSON** → a `.json` file downloads.
5. Move that file somewhere under `QA/config/` (git-ignored) and open it to copy its `client_email`.
6. Create a new Google Sheet, **Share** it with that email as **Editor**.
7. Copy the sheet id from its URL: `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.
8. Fill in `QA/config/qa.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=QA/config/google-service-account.json
   GOOGLE_SHEET_ID=<the id from step 7>
   ```

### Using it

```bash
npm run qa:sync           # one manual sync cycle, both directions
npm run qa:sync:watch     # leave running — local edits sync in ~1.5s, Sheet edits within ~20s
```

`qa:sync:watch` is a plain Node process (not something Claude runs for you) — start it in its own
terminal and leave it open, or wire it to run on login if you want it always on. Stop with Ctrl+C.

**Same convergence rules as the local Excel** (§3 above): id numbering never skips or duplicates
across both surfaces, and every manual verdict is preserved indefinitely until you clear the cell.

## 10. Automating this with CI (optional, hands-off)

If you want the report to refresh without you typing anything, add a GitHub Actions job
(`.github/workflows/qa.yml`) that runs on a schedule or on push:

```yaml
- run: cd QA && npm run qa:env && npm run qa
- run: cd QA && npm run qa:report
- run: cd QA && npm run qa:jira
  env:
    JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}
    JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
    JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
    JIRA_PROJECT_KEY: VC
- uses: actions/upload-artifact@v4
  with: { name: qa-report, path: QA/reports/VelChat-QA-Report.xlsx }
```
Put the Jira credentials in the repo's **Actions secrets**, never in the workflow file. This repo
does not have this job wired up yet — ask if you want it added.

## Quick reference

| I want to... | Run |
|---|---|
| Check the backend is actually up | `npm run qa:env` |
| Run everything against local | `npm run qa` |
| Just the auth/security tests | `npm run qa:api` |
| Just realtime/two-device | `npm run qa:websocket` |
| Client-side regression guards | `npm run qa:client` |
| Rebuild the Excel report | `npm run qa:report` |
| Preview what Jira would receive | `npm run qa:jira:dry` |
| Actually create/update Jira issues | `npm run qa:jira` |
| Sync Excel ↔ Google Sheet once | `npm run qa:sync` |
| Keep Excel ↔ Sheet synced continuously | `npm run qa:sync:watch` |
| Add one bug with a guaranteed-next id | `node scripts/add-bug.mjs <file-or-json>` |

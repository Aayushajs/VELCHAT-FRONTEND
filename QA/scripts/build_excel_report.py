#!/usr/bin/env python3
"""
Build/UPDATE QA/reports/VelChat-QA-Report.xlsx from the two machine-readable sources of truth:

  * QA/reports/results.jsonl  — one record per executed test case (written by QA/lib/results.js)
  * QA/reports/bugs.json      — the curated bug registry (steps, expected, actual, evidence, Jira)

SAME FILE, EVERY TIME. This never creates a new file — it always writes to
QA/reports/VelChat-QA-Report.xlsx (or the path given via --out), overwriting that one file in
place. A run against the same target never leaves a second copy anywhere.

UPSERT, NOT REBUILD, for the two verdict columns a human actually edits by hand:
  - "Test Results" sheet → the "Result" column
  - "Bugs" sheet        → the "Status" column
If the existing file already has a row for a Test ID / Bug ID, and its verdict cell holds a value
this script did NOT itself write last time (tracked in the sidecar `QA/reports/.excel_state.json`,
never guess from the value alone), that means a person typed it — e.g. "PASS (manual - verified on
OPPO CPH2643, video attached)" for something only a real device can confirm, or a considered
"Won't Fix". That value is preserved verbatim and is NEVER silently overwritten by a re-run,
regardless of what the automated tests say afterwards. Every other column in that row (evidence
path, device, dates, Jira key) still refreshes normally, so metadata never goes stale.
A brand-new Test ID / Bug ID that has never had a row before always gets the fresh computed
verdict — that's how a new bug shows up as the next sequential row, never a duplicate of one
already tracked (id allocation itself is guaranteed sequential by QA/scripts/lib/bug_ids.mjs).

Sheets
  1. Test Results  — the at-a-glance sheet: Test | Device | Result | Bug | Evidence
  2. Test Cases    — the full automated execution log (steps, expected, actual, timing) — NOT
                     sticky: this is a literal record of what the harness observed each run.
  3. Bugs          — the complete defect record with reproduction detail
  4. Summary       — totals, pass %, severity counts, release gate (computed from the RESOLVED
                     verdicts above, so a manual override is reflected here too)
  5. Device Matrix — coverage per device/OS
  6. Regression    — previously-fixed defects and whether they are still fixed
  7. Flaky         — tests whose result changed across runs

Usage:  python QA/scripts/build_excel_report.py [--out path.xlsx]
"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

QA_DIR = Path(__file__).resolve().parent.parent
REPORTS = QA_DIR / "reports"
RESULTS = REPORTS / "results.jsonl"
BUGS = REPORTS / "bugs.json"
STATE_PATH = REPORTS / ".excel_state.json"
BRIDGE_PATH = REPORTS / ".sync_bridge.json"

# ── palette ──────────────────────────────────────────────────────────────────
HEADER_FILL = PatternFill("solid", fgColor="1F2937")
HEADER_FONT = Font(color="FFFFFF", bold=True, size=11)
TITLE_FONT = Font(bold=True, size=14, color="1F2937")

STATUS_FILL = {
    "PASS": PatternFill("solid", fgColor="D1FAE5"),
    "FAIL": PatternFill("solid", fgColor="FEE2E2"),
    "BLOCKED": PatternFill("solid", fgColor="FEF3C7"),
    "SKIPPED": PatternFill("solid", fgColor="F3F4F6"),
    "FLAKY": PatternFill("solid", fgColor="FFEDD5"),
}
STATUS_FONT = {
    "PASS": Font(color="065F46", bold=True),
    "FAIL": Font(color="991B1B", bold=True),
    "BLOCKED": Font(color="92400E", bold=True),
    "SKIPPED": Font(color="6B7280"),
    "FLAKY": Font(color="9A3412", bold=True),
}
# A verdict that is NOT one of the tokens above was typed by a person, not written by this script.
# Style it distinctly (not red/green) so "someone made a call here" is visible at a glance.
MANUAL_FILL = PatternFill("solid", fgColor="DBEAFE")
MANUAL_FONT = Font(color="1E3A8A", bold=True, italic=True)

SEVERITY_FILL = {
    "P0": PatternFill("solid", fgColor="DC2626"),
    "P1": PatternFill("solid", fgColor="F97316"),
    "P2": PatternFill("solid", fgColor="FBBF24"),
    "P3": PatternFill("solid", fgColor="D1D5DB"),
}
SEVERITY_FONT = {
    "P0": Font(color="FFFFFF", bold=True),
    "P1": Font(color="FFFFFF", bold=True),
    "P2": Font(color="1F2937", bold=True),
    "P3": Font(color="1F2937"),
}
THIN = Side(style="thin", color="E5E7EB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

AUTOMATED_TEST_STATUSES = {"PASS", "FAIL", "BLOCKED", "SKIPPED", "FLAKY"}
AUTOMATED_BUG_STATUSES = {"Open", "Fixed", "Won't Fix", "In Progress", "Closed", "Duplicate"}


# ── sidecar state (tracks what THIS SCRIPT last wrote, to detect a human edit) ──────────────────
def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf8")


# ── sync bridge (shared with QA/scripts/sync/*.mjs — see bridge.mjs for the full contract) ──────
def load_bridge() -> dict:
    if not BRIDGE_PATH.exists():
        return {}
    try:
        return json.loads(BRIDGE_PATH.read_text(encoding="utf8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_bridge(bridge: dict) -> None:
    BRIDGE_PATH.write_text(json.dumps(bridge, indent=2, ensure_ascii=False), encoding="utf8")


def reconcile_with_bridge(bridge: dict, sheet: str, key: str, column: str, my_value: str, is_manual: bool) -> str:
    """
    Python-side twin of sync/bridge.mjs's `reconcile()` — same contract, same field names, so the
    two can read each other's writes. If I (the local builder) just detected a fresh human edit,
    announce it on the bridge for the Sheet to pick up. Otherwise, if the Sheet has already
    announced an edit I don't yet reflect, adopt it — pulling a Sheets-side edit into the local file.
    """
    existing = bridge.get(sheet, {}).get(key, {}).get(column)

    if is_manual:
        if existing and existing.get("source") == "sheets" and existing.get("value") != my_value:
            print(
                f'warning: conflict on {sheet}/{key}/{column}: local="{my_value}" '
                f'sheets="{existing.get("value")}" — keeping the local edit just made.'
            )
        bridge.setdefault(sheet, {}).setdefault(key, {})[column] = {
            "value": my_value,
            "source": "local",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        return my_value

    if existing and existing.get("source") == "sheets" and existing.get("value") != my_value:
        return existing["value"]

    if not existing:
        bridge.setdefault(sheet, {}).setdefault(key, {})[column] = {
            "value": my_value,
            "source": "automated",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    return my_value


def resolve_sticky(state: dict, sheet: str, key: str, column: str, fresh_value, existing_value, automated_set: set[str]):
    """
    Decide what to actually WRITE into a sticky (human-editable) cell.

    The sidecar state stores the AUTOMATED value this script computed last time — deliberately
    NOT whatever ended up written to the cell (a human override included). Comparing the file's
    current value against that automated baseline is what correctly detects "did a human change
    this since we last looked", on every run, no matter how many runs have passed since they made
    the edit or how many times the underlying automated truth has since changed.

      - no existing row                        → brand new, use the fresh value
      - no baseline yet (file predates this)    → trust it if it's a known automated token,
                                                   otherwise assume it was already a human's note
      - existing value == our last baseline     → nobody touched it since → safe to refresh
      - existing value != our last baseline     → a human changed it away from what we said →
                                                   preserve their value, untouched, indefinitely

    A human clears their override by emptying the cell — that reads back as "no existing row" and
    automation regains control from the next build onward.
    """
    bucket = state.setdefault(sheet, {}).setdefault(str(key), {})
    last_fresh = bucket.get(column)

    if existing_value in (None, ""):
        result = fresh_value
    elif last_fresh is None:
        result = fresh_value if str(existing_value) in automated_set else existing_value
    elif str(existing_value) == str(last_fresh):
        result = fresh_value
    else:
        result = existing_value

    bucket[column] = fresh_value  # always the AUTOMATED baseline, never the human's override
    return result


# ── loading ──────────────────────────────────────────────────────────────────
def load_results() -> list[dict]:
    if not RESULTS.exists():
        return []
    rows = []
    for line in RESULTS.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def load_bugs() -> dict:
    if not BUGS.exists():
        return {"meta": {}, "bugs": []}
    return json.loads(BUGS.read_text(encoding="utf8"))


def latest_per_test(rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rows:
        tid = r.get("testId")
        if not tid:
            continue
        if tid not in out or r.get("at", "") >= out[tid].get("at", ""):
            out[tid] = r
    return out


def detect_flaky(rows: list[dict]) -> dict[str, dict]:
    by_test: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("testId"):
            by_test[r["testId"]].append(r)

    flaky = {}
    for tid, records in by_test.items():
        statuses = [r.get("status") for r in records]
        distinct = {s for s in statuses if s in ("PASS", "FAIL")}
        if len(distinct) > 1:
            passes = statuses.count("PASS")
            fails = statuses.count("FAIL")
            flaky[tid] = {
                "title": records[-1].get("title", ""),
                "executions": len(records),
                "passes": passes,
                "failures": fails,
                "successRate": f"{(passes / max(1, passes + fails)) * 100:.0f}%",
                "devices": ", ".join(sorted({r.get("device", "?") for r in records})),
                "environments": ", ".join(sorted({r.get("apiBaseUrl", "?") for r in records})),
            }
    return flaky


# ── generic sheet helpers ────────────────────────────────────────────────────
def write_header(ws: Worksheet, headers: list[str], row: int = 1) -> None:
    for col, name in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=col, value=name)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center", horizontal="left", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 26
    ws.freeze_panes = ws.cell(row=row + 1, column=1)
    ws.auto_filter.ref = f"A{row}:{get_column_letter(len(headers))}{row}"


def set_widths(ws: Worksheet, widths: list[int]) -> None:
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def style_status(cell, status: str) -> None:
    if status in STATUS_FILL:
        cell.fill = STATUS_FILL[status]
        cell.font = STATUS_FONT[status]
    else:
        cell.fill = MANUAL_FILL
        cell.font = MANUAL_FONT
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def style_severity(cell, severity: str) -> None:
    sev = (severity or "").upper()
    if sev in SEVERITY_FILL:
        cell.fill = SEVERITY_FILL[sev]
        cell.font = SEVERITY_FONT[sev]
    cell.alignment = Alignment(horizontal="center", vertical="center")


def as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(f"{i}. {v}" for i, v in enumerate(value, start=1))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def evidence_label(paths: list[str]) -> str:
    if not paths:
        return "—"
    kinds = []
    joined = " ".join(paths).lower()
    if any(ext in joined for ext in (".png", ".jpg", "screenshot")):
        kinds.append("Screenshot")
    if any(ext in joined for ext in (".mp4", ".mov", "video")):
        kinds.append("Video")
    if any(ext in joined for ext in (".log", ".jsonl", ".txt", "logs")):
        kinds.append("Logs")
    if ".md" in joined:
        kinds.append("Audit")
    if any(ext in joined for ext in (".mjs", ".js", ".sh")):
        kinds.append("Repro script")
    return " + ".join(dict.fromkeys(kinds)) if kinds else "Attached"


def existing_sheet(wb, name):
    return wb[name] if wb is not None and name in wb.sheetnames else None


def build_key_row_map(ws, header_row: int, key_col: int) -> dict[str, int]:
    """Existing-sheet key -> row number, so an upsert can find "the row for this id" in O(1)."""
    m: dict[str, int] = {}
    if ws is None:
        return m
    for r in range(header_row + 1, ws.max_row + 1):
        v = ws.cell(row=r, column=key_col).value
        if v not in (None, ""):
            m[str(v)] = r
    return m


def cell_value(ws, row_num: int | None, col: int):
    if ws is None or row_num is None:
        return None
    return ws.cell(row=row_num, column=col).value


# ── sheets ───────────────────────────────────────────────────────────────────
def resolve_test_results(existing_wb, latest: dict[str, dict], bugs: list[dict], flaky: dict, state: dict, bridge: dict):
    """
    Compute the FINAL, MERGED per-test-id record for the "Test Results" sheet — resolving the
    sticky Result column against any human edit. Returned as {test_id: {title, device, result,
    bug, evidence, feature, is_manual}}, so both the sheet renderer AND the Summary/Device-Matrix
    sheets use exactly the same resolved truth.
    """
    old_ws = existing_sheet(existing_wb, "Test Results")
    key_row = build_key_row_map(old_ws, header_row=4, key_col=6)

    test_to_bug: dict[str, str] = {}
    bug_by_id = {b["id"]: b for b in bugs}
    for b in bugs:
        for tid in b.get("testIds", []):
            test_to_bug.setdefault(tid, b["id"])

    resolved: dict[str, dict] = {}
    for tid in sorted(set(latest) | set(key_row)):
        r = key_row.get(tid)
        rec = latest.get(tid)

        if rec is not None:
            fresh_status = "FLAKY" if tid in flaky else rec.get("status", "SKIPPED")
            bug_id = test_to_bug.get(tid, "")
            bug = bug_by_id.get(bug_id)
            fresh_evidence = evidence_label(bug.get("evidence", [])) if (fresh_status == "FAIL" and bug) else ("Logs" if fresh_status in ("FAIL", "FLAKY") else "—")
            fresh_bug_display = bug_id if fresh_status in ("FAIL", "FLAKY") and bug_id else "—"
            title = rec.get("title", tid)
            device = rec.get("device", "—")
            feature = rec.get("feature", "")
        else:
            # No fresh execution this run — a row existed before; keep its metadata verbatim,
            # the verdict itself still goes through the same sticky resolution below.
            fresh_status = str(cell_value(old_ws, r, 3) or "SKIPPED")
            fresh_bug_display = cell_value(old_ws, r, 4) or "—"
            fresh_evidence = cell_value(old_ws, r, 5) or "—"
            title = cell_value(old_ws, r, 1) or tid
            device = cell_value(old_ws, r, 2) or "—"
            feature = cell_value(old_ws, r, 7) or ""

        existing_result = cell_value(old_ws, r, 3)
        result = resolve_sticky(state, "Test Results", tid, "Result", fresh_status, existing_result, AUTOMATED_TEST_STATUSES)
        is_manual = result not in AUTOMATED_TEST_STATUSES
        result = reconcile_with_bridge(bridge, "Test Results", tid, "Result", result, is_manual)

        resolved[tid] = {
            "title": title,
            "device": device,
            "result": result,
            "bug": fresh_bug_display,
            "evidence": fresh_evidence,
            "feature": feature,
            "is_manual": result not in AUTOMATED_TEST_STATUSES,
        }
    return resolved


def sheet_test_results(wb: Workbook, resolved: dict[str, dict]) -> None:
    ws = wb.create_sheet("Test Results", 0)
    ws.cell(row=1, column=1, value="VelChat — QA Test Results").font = TITLE_FONT
    ws.cell(row=2, column=1, value=f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}").font = Font(
        italic=True, color="6B7280"
    )
    ws.cell(row=2, column=4, value="Blue rows = a person set this verdict by hand — never auto-overwritten.").font = Font(
        italic=True, color="1E3A8A"
    )

    headers = ["Test", "Device", "Result", "Bug", "Evidence", "Test ID", "Feature"]
    write_header(ws, headers, row=4)
    set_widths(ws, [58, 18, 16, 12, 30, 16, 22])

    row = 5
    for tid in sorted(resolved):
        rec = resolved[tid]
        ws.cell(row=row, column=1, value=rec["title"]).alignment = Alignment(wrap_text=True, vertical="top")
        ws.cell(row=row, column=2, value=rec["device"]).alignment = Alignment(horizontal="center")
        style_status(ws.cell(row=row, column=3, value=rec["result"]), rec["result"])
        cell_bug = ws.cell(row=row, column=4, value=rec["bug"])
        cell_bug.alignment = Alignment(horizontal="center")
        if rec["bug"] not in ("—", ""):
            cell_bug.font = Font(bold=True, color="991B1B")
        ws.cell(row=row, column=5, value=rec["evidence"]).alignment = Alignment(horizontal="center", wrap_text=True)
        ws.cell(row=row, column=6, value=tid)
        ws.cell(row=row, column=7, value=rec["feature"])
        for col in range(1, len(headers) + 1):
            ws.cell(row=row, column=col).border = BORDER
        row += 1


def sheet_test_cases(wb: Workbook, latest: dict[str, dict], bugs: list[dict], meta: dict) -> None:
    """The literal automated execution log — always fresh, never sticky (it IS the raw record)."""
    ws = wb.create_sheet("Test Cases")
    headers = [
        "Test ID", "Feature", "Scenario", "Preconditions", "Steps", "Expected", "Actual",
        "Status", "Severity", "Device", "OS", "Build", "Execution Date", "Duration (ms)", "Evidence", "Jira",
    ]
    write_header(ws, headers)
    set_widths(ws, [14, 20, 48, 30, 46, 46, 52, 10, 10, 16, 16, 22, 20, 13, 34, 12])

    jira_by_test: dict[str, str] = {}
    evidence_by_test: dict[str, str] = {}
    for b in bugs:
        for tid in b.get("testIds", []):
            if b.get("jira"):
                jira_by_test.setdefault(tid, b["jira"])
            evidence_by_test.setdefault(tid, "\n".join(b.get("evidence", [])))

    row = 2
    for tid in sorted(latest):
        rec = latest[tid]
        status = rec.get("status", "SKIPPED")
        values = [
            tid,
            rec.get("feature", ""),
            rec.get("title", ""),
            as_text(rec.get("preconditions")),
            as_text(rec.get("steps")),
            as_text(rec.get("expected")),
            as_text(rec.get("actual")) if status != "PASS" else "As expected",
            status,
            rec.get("severity") or "—",
            rec.get("device", ""),
            rec.get("os", ""),
            rec.get("build", meta.get("build", "")),
            (rec.get("at") or "")[:19].replace("T", " "),
            rec.get("durationMs", ""),
            evidence_by_test.get(tid, "QA/reports/results.jsonl"),
            jira_by_test.get(tid, ""),
        ]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.border = BORDER
        style_status(ws.cell(row=row, column=8), status)
        if rec.get("severity"):
            style_severity(ws.cell(row=row, column=9), rec["severity"])
        row += 1


def resolve_bugs(existing_wb, bugs: list[dict], latest: dict[str, dict], state: dict, bridge: dict):
    """Same sticky-resolution as test results, applied to the Bugs sheet's Status column."""
    old_ws = existing_sheet(existing_wb, "Bugs")
    key_row = build_key_row_map(old_ws, header_row=1, key_col=1)

    resolved = []
    for b in bugs:
        r = key_row.get(b["id"])
        fresh_status = b.get("status", "Open")
        existing_status = cell_value(old_ws, r, 7)
        status = resolve_sticky(state, "Bugs", b["id"], "Status", fresh_status, existing_status, AUTOMATED_BUG_STATUSES)
        is_manual = status not in AUTOMATED_BUG_STATUSES
        status = reconcile_with_bridge(bridge, "Bugs", b["id"], "Status", status, is_manual)
        resolved.append({**b, "_resolved_status": status, "_is_manual": status not in AUTOMATED_BUG_STATUSES})
    return resolved


def sheet_bugs(wb: Workbook, resolved_bugs: list[dict], latest: dict[str, dict]) -> None:
    ws = wb.create_sheet("Bugs")
    headers = [
        "Bug ID", "Jira ID", "Test ID", "Title", "Severity", "Priority", "Status", "Layer",
        "Feature", "Component", "Environment", "Device", "OS", "Frequency", "Reproducibility",
        "Preconditions", "Steps to Reproduce", "Expected", "Actual", "User Impact",
        "Suspected Cause", "Root Cause", "Evidence", "First Seen", "Last Seen", "Regression", "Notes",
    ]
    write_header(ws, headers)
    set_widths(
        ws,
        [10, 12, 22, 60, 10, 10, 16, 11, 20, 34, 28, 20, 16, 22, 24, 34, 60, 52, 60, 44, 48, 40, 38, 13, 13, 12, 44],
    )

    row = 2
    for b in resolved_bugs:
        first_seen = b.get("firstSeen") or ""
        last_seen = b.get("lastSeen") or ""
        if not first_seen:
            dates = [(latest.get(t) or {}).get("at", "") for t in b.get("testIds", [])]
            dates = sorted(d for d in dates if d)
            first_seen = dates[0][:10] if dates else "2026-09-11"
            last_seen = dates[-1][:10] if dates else "2026-09-11"

        values = [
            b.get("id", ""),
            b.get("jira", ""),
            ", ".join(b.get("testIds", [])),
            b.get("title", ""),
            b.get("severity", ""),
            b.get("priority", b.get("severity", "")),
            b["_resolved_status"],
            b.get("layer", ""),
            b.get("feature", ""),
            b.get("component", ""),
            b.get("environment", ""),
            b.get("device", ""),
            b.get("os", ""),
            b.get("frequency", ""),
            b.get("reproducibility", ""),
            as_text(b.get("preconditions")),
            as_text(b.get("steps")),
            as_text(b.get("expected")),
            as_text(b.get("actual")),
            as_text(b.get("user_impact")),
            as_text(b.get("suspected_cause")),
            as_text(b.get("rootCause")),
            "\n".join(b.get("evidence", [])),
            first_seen,
            last_seen,
            "Yes" if b.get("regression") else "No",
            as_text(b.get("notes")),
        ]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.border = BORDER
        status_cell = ws.cell(row=row, column=7)
        if b["_is_manual"]:
            status_cell.fill = MANUAL_FILL
            status_cell.font = MANUAL_FONT
        style_severity(ws.cell(row=row, column=5), b.get("severity", ""))
        style_severity(ws.cell(row=row, column=6), b.get("priority", b.get("severity", "")))
        ws.cell(row=row, column=1).font = Font(bold=True)
        row += 1


def sheet_summary(wb: Workbook, resolved: dict[str, dict], resolved_bugs: list[dict], flaky: dict, meta: dict) -> None:
    ws = wb.create_sheet("Summary")
    set_widths(ws, [38, 20, 60])

    # Counts come from the RESOLVED verdicts (manual overrides included), never raw automation
    # alone — a human-confirmed PASS counts as a pass here too. A manual verdict is classified by
    # simply looking for a FAIL/BLOCK word in what the person wrote; anything else manual (e.g.
    # "PASS (verified on device)") counts as a pass. Ambiguous manual text without any of those
    # words defaults to a pass, since the reviewer chose to log a positive result.
    passed = failed = blocked = skipped = 0
    manual_count = 0
    for rec in resolved.values():
        result = rec["result"]
        if rec["is_manual"]:
            manual_count += 1
            upper = result.upper()
            if "FAIL" in upper:
                failed += 1
            elif "BLOCK" in upper:
                blocked += 1
            else:
                passed += 1
            continue
        if result == "PASS":
            passed += 1
        elif result == "FAIL":
            failed += 1
        elif result == "BLOCKED":
            blocked += 1
        elif result == "SKIPPED":
            skipped += 1
        elif result == "FLAKY":
            failed += 1  # a flaky test is not a clean pass for the gate

    total = len(resolved)
    pass_pct = f"{(passed / total * 100):.1f}%" if total else "n/a"

    sev = Counter(b.get("severity", "P3") for b in resolved_bugs)
    open_bugs = sum(1 for b in resolved_bugs if b["_resolved_status"] not in ("Fixed", "Closed", "Won't Fix"))
    fixed_bugs = sum(1 for b in resolved_bugs if b["_resolved_status"] in ("Fixed", "Closed"))
    regressions = sum(1 for b in resolved_bugs if b.get("regression"))

    blockers = [b for b in resolved_bugs if b.get("severity") in ("P0", "P1") and b["_resolved_status"] not in ("Fixed", "Closed", "Won't Fix")]
    gate = "NO-GO" if any(b.get("severity") == "P0" for b in blockers) else ("GO WITH KNOWN ISSUES" if blockers else "GO")

    ws.cell(row=1, column=1, value="VelChat — QA Summary").font = TITLE_FONT
    row = 3

    def section(title: str) -> None:
        nonlocal row
        cell = ws.cell(row=row, column=1, value=title)
        cell.font = Font(bold=True, size=12, color="FFFFFF")
        cell.fill = HEADER_FILL
        ws.cell(row=row, column=2).fill = HEADER_FILL
        ws.cell(row=row, column=3).fill = HEADER_FILL
        row += 1

    def kv(label: str, value, note: str = "") -> None:
        nonlocal row
        ws.cell(row=row, column=1, value=label).font = Font(bold=True)
        ws.cell(row=row, column=2, value=value).alignment = Alignment(horizontal="left")
        ws.cell(row=row, column=3, value=note).alignment = Alignment(wrap_text=True, vertical="top")
        row += 1

    section("Execution")
    kv("Total tests tracked", total)
    kv("Passed", passed)
    kv("Failed", failed)
    kv("Blocked", blocked, "Environment invalid — never counted as a product defect (§47)")
    kv("Skipped", skipped)
    kv("Manually verified", manual_count, "A human set this verdict directly in Excel — preserved across every rebuild")
    kv("Flaky", len(flaky), "Result changed across runs — investigated, never auto-passed (§42)")
    kv("Pass percentage", pass_pct)
    row += 1

    section("Defects by severity")
    kv("P0 — Critical", sev.get("P0", 0))
    kv("P1 — High", sev.get("P1", 0))
    kv("P2 — Medium", sev.get("P2", 0))
    kv("P3 — Low", sev.get("P3", 0))
    kv("Open bugs", open_bugs)
    kv("Fixed bugs", fixed_bugs)
    kv("Regression bugs", regressions)
    row += 1

    section("Environment")
    kv("Build under test", meta.get("build", ""))
    row += 1

    section("Release gate (§41)")
    gate_cell = ws.cell(row=row, column=1, value="Recommendation")
    gate_cell.font = Font(bold=True)
    verdict = ws.cell(row=row, column=2, value=gate)
    verdict.font = Font(bold=True, size=12, color="FFFFFF")
    verdict.fill = PatternFill("solid", fgColor="DC2626" if gate == "NO-GO" else ("F97316" if gate != "GO" else "059669"))
    verdict.alignment = Alignment(horizontal="center")
    ws.cell(row=row, column=3, value=f"{len(blockers)} open P0/P1 defect(s) block the build.").alignment = Alignment(wrap_text=True)
    row += 2

    section("Blocking defects")
    for b in blockers:
        kv(b["id"], b.get("severity"), b.get("title", ""))


def sheet_device_matrix(wb: Workbook, resolved: dict[str, dict], meta: dict) -> None:
    ws = wb.create_sheet("Device Matrix")
    headers = ["Device", "OS", "App version", "Test count", "Pass", "Fail", "Blocked", "Notes"]
    write_header(ws, headers)
    set_widths(ws, [26, 20, 26, 12, 8, 8, 10, 70])

    per_device: dict[str, Counter] = defaultdict(Counter)
    for rec in resolved.values():
        bucket = "PASS" if (rec["result"] == "PASS" or (rec["is_manual"] and "FAIL" not in rec["result"].upper())) else rec["result"]
        per_device[rec["device"]][bucket] += 1

    notes = {
        "node-harness": "API + WebSocket contract tests run from Node against a real backend. No UI involved.",
        "emulator-5554": "Android emulator, API 36. NOT the §M0 reference device (3 GB Android 10).",
    }

    row = 2
    for device, counter in sorted(per_device.items()):
        total = sum(counter.values())
        values = [device, "", meta.get("build", ""), total, counter.get("PASS", 0), counter.get("FAIL", 0), counter.get("BLOCKED", 0), notes.get(device, "")]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.border = BORDER
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        row += 1

    row += 1
    ws.cell(row=row, column=1, value="Devices NOT covered in this run").font = Font(bold=True, size=12)
    row += 1
    for gap in [
        ("3 GB Android 10 handset", "Android 10 (API 29)", "The §M0 reference device. No such device or AVD available. VC-006/VC-012-class is Android <= 12 only and needs it."),
        ("iOS (any)", "iOS 17+", "Cannot be built on Windows — no macOS/Xcode/CocoaPods."),
    ]:
        for col, value in enumerate(gap, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.font = Font(italic=True, color="6B7280")
        ws.cell(row=row, column=1).font = Font(italic=True, bold=True, color="92400E")
        row += 1


def sheet_regression(wb: Workbook, resolved_bugs: list[dict], latest: dict[str, dict]) -> None:
    ws = wb.create_sheet("Regression")
    headers = ["Bug ID", "Title", "Severity", "Fixed in", "Guard test", "Current result", "Still fixed?", "Notes"]
    write_header(ws, headers)
    set_widths(ws, [10, 60, 10, 18, 22, 16, 14, 56])

    row = 2
    tracked = [b for b in resolved_bugs if b["_resolved_status"] in ("Fixed", "Closed") or b.get("regression")]
    if not tracked:
        ws.cell(
            row=row, column=2,
            value="No defect is marked Fixed yet. Set a bug's Status to \"Fixed\" (in bugs.json, or "
            "directly in this workbook's Bugs sheet — that edit is preserved) and it appears here "
            "on the next report build, guarded by its covering test.",
        ).alignment = Alignment(wrap_text=True, vertical="top")
        return

    for b in tracked:
        guard = ", ".join(b.get("testIds", []))
        current = {(latest.get(t) or {}).get("status") for t in b.get("testIds", [])}
        still = "Yes" if current == {"PASS"} else ("Not independently tested" if not current or current == {None} else "NO — REGRESSED")
        values = [b["id"], b.get("title", ""), b.get("severity", ""), b.get("fixedIn", ""), guard,
                  "/".join(sorted(s for s in current if s)), still, as_text(b.get("notes"))]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.border = BORDER
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        if still.startswith("NO"):
            style_status(ws.cell(row=row, column=7), "FAIL")
        row += 1


def sheet_flaky(wb: Workbook, flaky: dict) -> None:
    ws = wb.create_sheet("Flaky")
    headers = ["Test ID", "Title", "Executions", "Failures", "Success rate", "Devices", "Environments"]
    write_header(ws, headers)
    set_widths(ws, [16, 58, 12, 10, 13, 26, 40])

    row = 2
    if not flaky:
        ws.cell(
            row=row, column=2,
            value="No test has produced different results across runs. A retry that changes a "
            "result is recorded as FLAKY and investigated — never silently promoted to PASS (§42/§46).",
        ).alignment = Alignment(wrap_text=True, vertical="top")
        return

    for tid, info in sorted(flaky.items()):
        values = [tid, info["title"], info["executions"], info["failures"], info["successRate"], info["devices"], info["environments"]]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=col, value=value)
            cell.border = BORDER
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        style_status(ws.cell(row=row, column=1), "FLAKY")
        row += 1


def save_with_retry(wb: Workbook, out: Path, attempts: int = 3, delay_sec: float = 1.5) -> None:
    """
    Windows locks an .xlsx while it's open in Excel. Retry briefly, then fail LOUDLY with exact
    guidance — never fall back to writing a second file, which is precisely what must not happen.
    """
    last_error: PermissionError | None = None
    for attempt in range(1, attempts + 1):
        try:
            wb.save(out)
            return
        except PermissionError as e:
            last_error = e
            if attempt < attempts:
                time.sleep(delay_sec)
    raise SystemExit(
        f"\nCould not save {out} — it looks like it's open in Excel (or another program) and locked "
        f"for writing.\nClose it and re-run `npm run qa:report`. Nothing was written; your existing "
        f"file (and every manual edit in it) is untouched.\n({last_error})"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPORTS / "VelChat-QA-Report.xlsx"))
    args = ap.parse_args()
    out = Path(args.out)

    rows = load_results()
    registry = load_bugs()
    bugs = registry.get("bugs", [])
    meta = registry.get("meta", {})
    latest = latest_per_test(rows)
    flaky = detect_flaky(rows)
    state = load_state()
    bridge = load_bridge()

    existing_wb = None
    if out.exists():
        try:
            existing_wb = load_workbook(out)
        except Exception as e:  # corrupt/foreign file — rebuild fresh rather than crash
            print(f"warning: could not read existing {out} ({e}); building fresh.")

    resolved_tests = resolve_test_results(existing_wb, latest, bugs, flaky, state, bridge)
    resolved_bugs = resolve_bugs(existing_wb, bugs, latest, state, bridge)

    wb = Workbook()
    wb.remove(wb.active)

    sheet_test_results(wb, resolved_tests)
    sheet_test_cases(wb, latest, bugs, meta)
    sheet_bugs(wb, resolved_bugs, latest)
    sheet_summary(wb, resolved_tests, resolved_bugs, flaky, meta)
    sheet_device_matrix(wb, resolved_tests, meta)
    sheet_regression(wb, resolved_bugs, latest)
    sheet_flaky(wb, flaky)

    save_with_retry(wb, out)
    save_state(state)
    save_bridge(bridge)

    manual_tests = sum(1 for r in resolved_tests.values() if r["is_manual"])
    manual_bugs = sum(1 for b in resolved_bugs if b["_is_manual"])
    print(f"Updated {out}")
    print(f"  test rows : {len(resolved_tests)}  (manual verdicts preserved: {manual_tests})")
    print(f"  bug rows  : {len(resolved_bugs)}  (manual statuses preserved: {manual_bugs})")
    print(f"  flaky     : {len(flaky)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

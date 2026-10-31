#!/usr/bin/env python3
"""Validate and render the local delivery graph. No external tracker writes."""
import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "docs/tickets/catalog.json"
VALID_STATUSES = {"planned", "in_progress", "blocked", "verified"}


def validate(data, source):
    errors = []
    all_stories = set(re.findall(r"^### ([FCSAKM]\d+)\s", source, re.M))
    excluded = set(data.get("excluded_stories", []))
    if excluded != {"K06"}:
        errors.append("Only the explicitly deferred K06 record may be excluded.")
    expected = all_stories - excluded
    if len(expected) != 35:
        errors.append(f"Expected 35 confirmed stories, found {len(expected)}; review scope changes deliberately.")
    tickets = data.get("tickets", [])
    by_id = {t["id"]: t for t in tickets}
    if len(by_id) != len(tickets):
        errors.append("Duplicate ticket identifier.")
    covered = set()
    for ticket in tickets:
        name = ticket["id"]
        if ticket.get("kind", "feature") != "integration":
            covered.update(ticket.get("stories", []))
        if not re.fullmatch(r"RW-\d{2}", name):
            errors.append(f"Invalid ticket identifier: {name}")
        if ticket.get("status") not in VALID_STATUSES:
            errors.append(f"{name}: invalid status")
        for key in ("title", "outcome", "stories", "seams", "acceptance"):
            if not ticket.get(key):
                errors.append(f"{name}: missing {key}")
        unknown = set(ticket.get("stories", [])) - expected
        if unknown:
            errors.append(f"{name}: unknown/deferred stories: {', '.join(sorted(unknown))}")
        for dependency in ticket.get("blocked_by", []):
            if dependency not in by_id:
                errors.append(f"{name}: missing blocker {dependency}")
        if ticket.get("status") == "verified":
            if not ticket.get("evidence"):
                errors.append(f"{name}: verified status requires recorded positive evidence")
            for dependency in ticket.get("blocked_by", []):
                if dependency in by_id and by_id[dependency].get("status") != "verified":
                    errors.append(f"{name}: cannot verify before blocker {dependency}")
    missing = expected - covered
    if missing:
        errors.append("Stories without a feature ticket: " + ", ".join(sorted(missing)))
    visiting, done = set(), set()

    def visit(name):
        if name in visiting:
            errors.append(f"Dependency cycle at {name}")
            return
        if name in done or name not in by_id:
            return
        visiting.add(name)
        for blocker in by_id[name].get("blocked_by", []):
            visit(blocker)
        visiting.remove(name)
        done.add(name)

    for name in by_id:
        visit(name)
    return errors


def render(ticket, by_id):
    blockers = ", ".join(f"[{key}: {by_id[key]['title']}]({key}.md)" for key in ticket["blocked_by"]) or "None."
    lines = [f"# {ticket['id']}: {ticket['title']}", "", f"Status: {ticket['status']}",
             "", "Local delivery ticket, not a published GitHub issue.", "",
             "## What to build", "", ticket["outcome"], "", "## Traceability", "",
             "Confirmed stories: " + ", ".join(ticket["stories"]) + ".",
             "Quality gates: Q01–Q05 apply to this slice.", "", "## Blocked by", "", blockers,
             "", "## Public verification seams", ""]
    lines += ["- " + s for s in ticket["seams"]]
    lines += ["", "## Acceptance criteria", ""]
    lines += ["- [ ] " + s for s in ticket["acceptance"]]
    lines += ["", "## Verification evidence", ""]
    lines += ["- " + s for s in ticket["evidence"]] if ticket["evidence"] else ["No complete end-to-end acceptance evidence recorded yet. Partial code or a passing focused test does not close this ticket."]
    lines += ["", "Generated from catalog.json by scripts/tickets.py. Change the catalog, then regenerate; keep substantive evidence in linked review/test reports.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "render", "frontier"])
    args = parser.parse_args()
    data = json.loads(CATALOG.read_text())
    errors = validate(data, (ROOT / data["scope_source"]).read_text())
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    by_id = {t["id"]: t for t in data["tickets"]}
    for ticket in data["tickets"]:
        path = CATALOG.parent / (ticket["id"] + ".md")
        expected = render(ticket, by_id)
        if args.command == "render":
            path.write_text(expected)
        elif args.command == "check" and (not path.exists() or path.read_text() != expected):
            errors.append(f"{path.relative_to(ROOT)} is stale; run python3 scripts/tickets.py render")
        elif args.command == "frontier" and ticket["status"] != "verified" and all(by_id[k]["status"] == "verified" for k in ticket["blocked_by"]):
            print(f"{ticket['id']} [{ticket['status']}] {ticket['title']}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    if args.command != "frontier":
        print(f"Ticket DAG: {len(by_id)} local tickets, 35/35 confirmed stories covered, no cycles; {args.command} passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

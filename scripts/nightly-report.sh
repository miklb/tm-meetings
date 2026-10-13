#!/bin/bash
# nightly-report.sh — turn the nightly scrape's staged changes and log into
# the GitHub issue body the workflow posts. Runs in CI after `git add -A`;
# runs the same way locally against your own staged changes.
#
#   SCRAPE_LOG=/tmp/scrape-output.log   scraper stdout+stderr (tee'd by the workflow)
#   SCRAPE_OUTCOME=success|failure      the scrape step's outcome
#   VRB_LOG=/tmp/vrb-output.log         vrb-scraper.js stdout+stderr
#   VRB_OUTCOME=success|failure         the VRB collection step's outcome
#   OUT=/tmp/issue-body.md              where to write the issue body
#
# Writes has_meaningful=true|false to $GITHUB_OUTPUT when set, else to stdout.
# Exit code is always 0: reporting must never be the thing that fails the night.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRAPE_LOG="${SCRAPE_LOG:-/tmp/scrape-output.log}"
SCRAPE_OUTCOME="${SCRAPE_OUTCOME:-success}"
VRB_LOG="${VRB_LOG:-/tmp/vrb-output.log}"
VRB_OUTCOME="${VRB_OUTCOME:-success}"
OUT="${OUT:-/tmp/issue-body.md}"
DATA_DIR="${DATA_DIR:-agenda-scraper/data}"   # stored meeting JSON (tests point this elsewhere)
TODAY="$(date +%Y-%m-%d)"
cd "$REPO_ROOT"

NEW_MEETINGS=""
MODIFIED_MEETINGS=""
UNAVAILABLE_MEETINGS=""
UNAVAILABLE_ARCHIVED=""
FAILED_MEETINGS=""
SUPPRESSED_COUNT=0
HAS_MEANINGFUL=false

meeting_id()   { sed 's/.*meeting_\([0-9]*\)_.*/\1/' <<< "$1"; }
meeting_date() { sed 's/.*meeting_[0-9]*_\(.*\)\.json/\1/' <<< "$1"; }

# Items lib/scrape-guard.js wrote back from the stored file for one meeting.
# json-scraper.js logs each as
#   "Meeting 2935: kept stored version of item 4 (all 7 documents missing)".
kept_items() {
  [[ -f "$SCRAPE_LOG" ]] || return 0
  grep "Meeting $1: kept stored version of item " "$SCRAPE_LOG" | sed 's/.*kept stored version of item /  - item /'
}

# New meeting files
for file in $(git diff --staged --diff-filter=A --name-only -- 'agenda-scraper/data/meeting_*.json'); do
  HAS_MEANINGFUL=true
  MEETING_TYPE=$(jq -r '.meetingType // "unknown"' "$file" 2>/dev/null || echo unknown)
  MEETING_NAME=$(jq -r '.meetingName // empty' "$file" 2>/dev/null)
  NEW_MEETINGS="${NEW_MEETINGS}- **Meeting $(meeting_id "$file")** — $(meeting_date "$file") (${MEETING_TYPE}${MEETING_NAME:+, ${MEETING_NAME}})"$'\n'
done

# Modified meeting files — diff-without-urls.js filters URL-only churn.
# When the scrape guard wrote stored items back for a meeting, say so right
# under its changes: "Removed documents" reads very differently once you know
# the rest of the page came back empty (2935 on 10/12/26 — the city was
# republishing the agenda item by item and the issue did not say so).
GUARD_HELD_INLINE=""
for file in $(git diff --staged --diff-filter=M --name-only -- 'agenda-scraper/data/meeting_*.json'); do
  MID=$(meeting_id "$file")
  DIFF_OUTPUT=$(git show HEAD:"$file" | node agenda-scraper/diff-without-urls.js --summary - "$file" 2>/dev/null || echo "")
  if [[ -n "$DIFF_OUTPUT" && "$DIFF_OUTPUT" != *"No meaningful changes"* ]]; then
    HAS_MEANINGFUL=true
    MODIFIED_MEETINGS="${MODIFIED_MEETINGS}### Meeting ${MID} ($(meeting_date "$file"))"$'\n'"${DIFF_OUTPUT}"$'\n'
    HELD=$(kept_items "$MID")
    if [[ -n "$HELD" ]]; then
      MODIFIED_MEETINGS="${MODIFIED_MEETINGS}"$'\n'"**Scrape guard kept stored items** — the fresh scrape returned these without documents, so the stored copies were written back unchanged (the city page was likely mid-republish):"$'\n'"${HELD}"$'\n'
      GUARD_HELD_INLINE="${GUARD_HELD_INLINE} ${MID} "
    fi
    MODIFIED_MEETINGS="${MODIFIED_MEETINGS}"$'\n'
  elif [[ -n "$DIFF_OUTPUT" ]]; then
    SUPPRESSED_COUNT=$((SUPPRESSED_COUNT + 1))
  fi
done

# Variance Review Board hearings: vrb-scraper.js only rewrites a hearing file
# when a document was added or revised, so any staged change is meaningful.
VRB_HEARINGS=""
for file in $(git diff --staged --diff-filter=AM --name-only -- 'agenda-scraper/data/vrb/vrb_*.json'); do
  HAS_MEANINGFUL=true
  VRB_HEARINGS="${VRB_HEARINGS}- **$(jq -r '.hearingDate' "$file")** — $(jq -r '.cases | length' "$file") cases; documents: $(jq -r '[.documents[].title] | join(", ")' "$file")"$'\n'
done
VRB_TAIL=""
if [[ "$VRB_OUTCOME" == "failure" ]]; then
  HAS_MEANINGFUL=true
  [[ -f "$VRB_LOG" ]] && VRB_TAIL=$(tail -n 10 "$VRB_LOG")
fi

# Scraper log: meetings the server said are unavailable, and meetings whose
# scrape errored (json-scraper.js skips them and exits non-zero at the end).
if [[ -f "$SCRAPE_LOG" ]]; then
  while IFS= read -r line; do
    if [[ "$line" == *"is not available on the server"* ]]; then
      MID=$(grep -o 'Meeting [0-9]*' <<< "$line" | head -1 | awk '{print $2}')
      # The scraper skips an unavailable meeting and writes nothing, so a
      # meeting we already hold is safe. When its date has passed, the city
      # has simply pulled an old page while leaving it on the list (2935, the
      # 10/8/26 evening session, did this and opened an issue every night).
      # Note it for the record without opening an issue for it alone. A
      # meeting we never captured, or one still ahead on the calendar, is a
      # real gap and stays meaningful.
      STORED=$(ls "$DATA_DIR"/meeting_"${MID}"_*.json 2>/dev/null | head -1)
      if [[ -n "$STORED" && "$(meeting_date "$STORED")" < "$TODAY" ]]; then
        UNAVAILABLE_ARCHIVED="${UNAVAILABLE_ARCHIVED}- Meeting **${MID}** ($(meeting_date "$STORED")) — page gone from the server; stored copy and post unchanged"$'\n'
      else
        HAS_MEANINGFUL=true
        UNAVAILABLE_MEETINGS="${UNAVAILABLE_MEETINGS}- Meeting **${MID}** returned \"Meeting not available\" from the server"$'\n'
      fi
    elif [[ "$line" == *"Skipping meeting"*"after error"* ]]; then
      HAS_MEANINGFUL=true
      MID=$(grep -o 'Skipping meeting [0-9]*' <<< "$line" | awk '{print $3}')
      REASON=${line#*after error: }
      FAILED_MEETINGS="${FAILED_MEETINGS}- Meeting **${MID}**: ${REASON}"$'\n'
    fi
  done < "$SCRAPE_LOG"
fi

# Meetings the guard held items for whose file did not change meaningfully
# (or at all): list them for the record when something else opens the issue.
# Not meaningful on their own — the stored copy and post are untouched, the
# same footing as an unavailable archived meeting.
GUARD_HELD=""
if [[ -f "$SCRAPE_LOG" ]]; then
  for MID in $(grep -o 'Meeting [0-9]*: kept stored version' "$SCRAPE_LOG" | awk '{print $2}' | tr -d ':' | sort -u); do
    [[ "$GUARD_HELD_INLINE" == *" ${MID} "* ]] && continue
    STORED=$(ls "$DATA_DIR"/meeting_"${MID}"_*.json 2>/dev/null | head -1)
    GUARD_HELD="${GUARD_HELD}- Meeting **${MID}**${STORED:+ ($(meeting_date "$STORED"))} — stored items written back because the fresh scrape returned them without documents:"$'\n'"$(kept_items "$MID")"$'\n'
  done
fi

# The scrape step itself failed and no per-meeting line explains it (OnBase
# unreachable, list page changed shape, …): show the end of the log.
SCRAPE_TAIL=""
if [[ "$SCRAPE_OUTCOME" != "success" ]]; then
  HAS_MEANINGFUL=true
  if [[ -z "$FAILED_MEETINGS" && -f "$SCRAPE_LOG" ]]; then
    SCRAPE_TAIL=$(tail -n 20 "$SCRAPE_LOG")
  fi
fi

if [[ "$HAS_MEANINGFUL" == "true" ]]; then
  {
    echo "@miklb"
    echo ""
    if [[ "$SCRAPE_OUTCOME" != "success" ]]; then
      echo "## Nightly Scrape — ⚠️ scrape reported failures"
    else
      echo "## Nightly Scrape — Changes Detected"
    fi
    echo ""
    if [[ -n "$NEW_MEETINGS" ]]; then
      echo "### New Meetings"
      echo "$NEW_MEETINGS"
    fi
    if [[ -n "$MODIFIED_MEETINGS" ]]; then
      echo "### Modified Meetings"
      echo "$MODIFIED_MEETINGS"
    fi
    if [[ -n "$UNAVAILABLE_MEETINGS" ]]; then
      echo "### ⚠️ Unavailable Meetings (server returned \"Meeting not available\")"
      echo "$UNAVAILABLE_MEETINGS"
    fi
    if [[ -n "$UNAVAILABLE_ARCHIVED" ]]; then
      echo "### Unavailable on the server, already archived (informational)"
      echo "$UNAVAILABLE_ARCHIVED"
    fi
    if [[ -n "$GUARD_HELD" ]]; then
      echo "### Scrape guard kept stored items (informational)"
      echo "$GUARD_HELD"
    fi
    if [[ -n "$FAILED_MEETINGS" ]]; then
      echo "### ❌ Meetings that failed to scrape (stored files untouched; the rest of the night was committed)"
      echo "$FAILED_MEETINGS"
      echo "Re-run by hand: \`cd agenda-scraper && ./process-agenda.sh <date>\`"
      echo ""
    fi
    if [[ -n "$SCRAPE_TAIL" ]]; then
      echo "### ❌ Scrape step failed (exit non-zero) — last 20 log lines"
      echo '```'
      echo "$SCRAPE_TAIL"
      echo '```'
      echo ""
    fi
    if [[ -n "$VRB_HEARINGS" ]]; then
      echo "### Variance Review Board — new or revised"
      echo "$VRB_HEARINGS"
    fi
    if [[ -n "$VRB_TAIL" ]]; then
      echo "### ❌ VRB collection failed — last 10 log lines"
      echo '```'
      echo "$VRB_TAIL"
      echo '```'
      echo ""
    fi
    if [[ "$SUPPRESSED_COUNT" -gt 0 ]]; then
      echo ""
      echo "_Note: ${SUPPRESSED_COUNT} meeting(s) had only URL/schema-only changes — suppressed._"
    fi
    echo "---"
    echo "*Auto-generated by nightly scrape workflow (scripts/nightly-report.sh)*"
  } > "$OUT"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "has_meaningful=${HAS_MEANINGFUL}" >> "$GITHUB_OUTPUT"
else
  echo "has_meaningful=${HAS_MEANINGFUL}"
fi
exit 0

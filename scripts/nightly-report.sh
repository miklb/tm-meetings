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
cd "$REPO_ROOT"

NEW_MEETINGS=""
MODIFIED_MEETINGS=""
UNAVAILABLE_MEETINGS=""
FAILED_MEETINGS=""
SUPPRESSED_COUNT=0
HAS_MEANINGFUL=false

meeting_id()   { sed 's/.*meeting_\([0-9]*\)_.*/\1/' <<< "$1"; }
meeting_date() { sed 's/.*meeting_[0-9]*_\(.*\)\.json/\1/' <<< "$1"; }

# New meeting files
for file in $(git diff --staged --diff-filter=A --name-only -- 'agenda-scraper/data/meeting_*.json'); do
  HAS_MEANINGFUL=true
  MEETING_TYPE=$(jq -r '.meetingType // "unknown"' "$file" 2>/dev/null || echo unknown)
  MEETING_NAME=$(jq -r '.meetingName // empty' "$file" 2>/dev/null)
  NEW_MEETINGS="${NEW_MEETINGS}- **Meeting $(meeting_id "$file")** — $(meeting_date "$file") (${MEETING_TYPE}${MEETING_NAME:+, ${MEETING_NAME}})"$'\n'
done

# Modified meeting files — diff-without-urls.js filters URL-only churn
for file in $(git diff --staged --diff-filter=M --name-only -- 'agenda-scraper/data/meeting_*.json'); do
  DIFF_OUTPUT=$(git show HEAD:"$file" | node agenda-scraper/diff-without-urls.js --summary - "$file" 2>/dev/null || echo "")
  if [[ -n "$DIFF_OUTPUT" && "$DIFF_OUTPUT" != *"No meaningful changes"* ]]; then
    HAS_MEANINGFUL=true
    MODIFIED_MEETINGS="${MODIFIED_MEETINGS}### Meeting $(meeting_id "$file") ($(meeting_date "$file"))"$'\n'"${DIFF_OUTPUT}"$'\n\n'
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
      HAS_MEANINGFUL=true
      MID=$(grep -o 'Meeting [0-9]*' <<< "$line" | head -1 | awk '{print $2}')
      UNAVAILABLE_MEETINGS="${UNAVAILABLE_MEETINGS}- Meeting **${MID}** returned \"Meeting not available\" from the server"$'\n'
    elif [[ "$line" == *"Skipping meeting"*"after error"* ]]; then
      HAS_MEANINGFUL=true
      MID=$(grep -o 'Skipping meeting [0-9]*' <<< "$line" | awk '{print $3}')
      REASON=${line#*after error: }
      FAILED_MEETINGS="${FAILED_MEETINGS}- Meeting **${MID}**: ${REASON}"$'\n'
    fi
  done < "$SCRAPE_LOG"
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

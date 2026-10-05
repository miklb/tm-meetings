#!/usr/bin/env bash
# pipeline/git-sync.sh — keep pipeline output in sync with origin.
#
# The nightly scrape commits to origin/main every night. A local run whose
# commit is still unpushed when the nightly lands produces a merge conflict on
# the same meeting files (2026-09-29: four hunks, resolved by hand). The cause
# is always the same — local commits not pushed in time — so the pipeline
# scripts fast-forward before they start and commit + push what they wrote
# when they finish.
#
# Source this file (bash 3.2 is enough), then:
#   git_sync_start                       fetch; fast-forward if behind; refuse
#                                        to run if local and origin diverged
#   git_sync_finish_agenda <date>        commit "update M/D/YY agenda", push
#   git_sync_finish_archive <date> <pkey>...
#                                        commit "archive M/D/YY", push
#   git_sync_finish <message> <pathspec>...   the general form
#
# Honours: SYNC=false   (from --no-sync)  both calls are no-ops
#          DRY_RUN=true                   say what would happen, touch nothing
# Never rebases: pull.rebase=false is deliberate; nightly commits are merged.

git_sync_root() { git rev-parse --show-toplevel 2>/dev/null; }

# 2026-10-01 → 10/1/26 (the commit-message convention)
short_date() {
    local d="$1" m day y
    m="${d:5:2}"; day="${d:8:2}"; y="${d:2:2}"
    echo "${m#0}/${day#0}/$y"
}

git_sync_start() {
    if [ "${SYNC:-true}" != "true" ]; then
        echo "⏭  Git sync skipped (--no-sync)"
        return 0
    fi
    local root branch local_ref remote_ref base
    root=$(git_sync_root) || { echo "❌ Git sync: not inside a git repository"; return 1; }
    branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
    if [ "${DRY_RUN:-false}" = "true" ]; then
        echo "[dry-run] would fetch origin/$branch and fast-forward if behind"
        return 0
    fi
    if ! git -C "$root" diff --cached --quiet; then
        echo "❌ Git sync: the index already has staged changes. Commit or unstage them first,"
        echo "   so the run's commit holds only what the run wrote."
        return 1
    fi
    echo "Git sync: fetching origin/$branch..."
    if ! git -C "$root" fetch --quiet origin "$branch"; then
        echo "❌ Git sync: fetch failed. Check network/auth, or re-run with --no-sync."
        return 1
    fi
    local_ref=$(git -C "$root" rev-parse HEAD)
    remote_ref=$(git -C "$root" rev-parse "origin/$branch")
    base=$(git -C "$root" merge-base HEAD "origin/$branch")
    if [ "$local_ref" = "$remote_ref" ]; then
        echo "✓ In sync with origin/$branch"
    elif [ "$base" = "$remote_ref" ]; then
        echo "✓ Ahead of origin/$branch by $(git -C "$root" rev-list --count "origin/$branch..HEAD") commit(s); pushed at the end of the run"
    elif [ "$base" = "$local_ref" ]; then
        echo "Git sync: behind origin/$branch, fast-forwarding..."
        if ! git -C "$root" merge --ff-only --quiet "origin/$branch"; then
            echo "❌ Git sync: fast-forward refused. Uncommitted changes overlap files origin changed;"
            echo "   commit or stash them, then re-run."
            return 1
        fi
        echo "✓ Fast-forwarded to origin/$branch"
    else
        echo "❌ Git sync: local $branch and origin/$branch have diverged (both have new commits)."
        echo "   Merge first, never rebase:  git pull"
        echo "   then re-run. --no-sync skips this check."
        return 1
    fi
}

git_sync_finish() {
    if [ "${SYNC:-true}" != "true" ]; then
        return 0
    fi
    local message="$1"; shift
    local root branch spec n=0
    root=$(git_sync_root) || { echo "❌ Git sync: not inside a git repository"; return 1; }
    branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
    # git add fails on a pathspec that matches nothing, so keep only the
    # pathspecs with something new, modified or deleted behind them.
    local -a specs
    for spec in "$@"; do
        if [ -n "$(git -C "$root" status --porcelain --untracked-files=all -- "$spec")" ]; then
            specs[n]="$spec"; n=$((n + 1))
        fi
    done
    if [ "${DRY_RUN:-false}" = "true" ]; then
        echo "[dry-run] would commit \"$message\" ($n pathspec(s) with changes) and push origin/$branch"
        return 0
    fi
    if ! git -C "$root" diff --cached --quiet; then
        echo "❌ Git sync: the index has staged changes that are not from this run; not committing."
        echo "   Sort them out, then: git add <run output> && git commit && git push"
        return 1
    fi
    if [ "$n" -gt 0 ]; then
        git -C "$root" add -A -- "${specs[@]}" || return 1
    fi
    if git -C "$root" diff --cached --quiet; then
        echo "Git sync: nothing new to commit"
    else
        git -C "$root" commit --quiet -m "$message" || return 1
        echo "✓ Committed: $message"
        git -C "$root" show --stat --format= HEAD | sed 's/^/    /'
    fi
    if [ "$(git -C "$root" rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)" = "0" ]; then
        echo "✓ Nothing to push"
        return 0
    fi
    if git -C "$root" push --quiet origin "$branch"; then
        echo "✓ Pushed to origin/$branch"
    else
        echo "❌ Git sync: push failed. Run:  git push"
        echo "   Until these commits land, the nightly scrape will conflict with them."
        return 1
    fi
}

# Everything an agenda run writes for one date. data/*<date>* also reaches
# data/changes/ and data/locations/ (a git pathspec '*' crosses '/').
git_sync_finish_agenda() {
    local date="$1"
    git_sync_finish "update $(short_date "$date") agenda" \
        "agenda-scraper/data/*${date}*" \
        "agenda-scraper/agendas/agenda_${date}.md"
}

# Everything an archive run writes: the Step 0 agenda re-check, the raw and
# processed transcripts for the date, and one video mapping per pkey.
git_sync_finish_archive() {
    local date="$1"; shift
    local -a specs
    local n=0 pkey
    specs[n]="agenda-scraper/data/*${date}*"; n=$((n + 1))
    specs[n]="agenda-scraper/agendas/agenda_${date}.md"; n=$((n + 1))
    specs[n]="transcript-cleaner/processor/data/transcripts/*_${date}.json"; n=$((n + 1))
    specs[n]="transcript-cleaner/processor/data/processed/*_${date}.json"; n=$((n + 1))
    for pkey in "$@"; do
        specs[n]="transcript-cleaner/processor/data/video_mapping_${pkey}.json"; n=$((n + 1))
    done
    git_sync_finish "archive $(short_date "$date")" "${specs[@]}"
}

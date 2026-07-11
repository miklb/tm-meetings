#!/usr/bin/env bash
#
# add-beta-tester.sh — Add email(s) to the beta_testers table in remote D1.
#
# Beta testers can subscribe to keyword notifications at
# https://meetings.tampamonitor.com/notifications/ while REGISTRATION_MODE
# is BETA_AND_SUPPORTERS (see docs/KEYWORD-NOTIFICATIONS-PLAN.md).
#
# Usage:
#   ./scripts/add-beta-tester.sh someone@example.com [more@example.com ...]
#   ./scripts/add-beta-tester.sh --list        # just show the current list

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$(cd "$SCRIPT_DIR/../site" && pwd)"
DB_NAME="tampa-meetings-notifications"

# npx resolves `node` from PATH, and /usr/local/bin/node is too old for
# wrangler — prefer the newest nvm-installed node when available.
if [[ -d "$HOME/.nvm/versions/node" ]]; then
    LATEST_NODE="$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)"
    export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
fi

d1() {
    (cd "$SITE_DIR" && npx wrangler d1 execute "$DB_NAME" --remote --command "$1")
}

list_testers() {
    d1 "SELECT email, created_at FROM beta_testers ORDER BY created_at;"
}

if [[ $# -eq 0 ]]; then
    echo "Usage: $0 email [email ...]   (or --list)" >&2
    exit 1
fi

if [[ "$1" == "--list" ]]; then
    list_testers
    exit 0
fi

VALUES=""
for raw in "$@"; do
    # subscribe.js compares stored emails lowercased and trimmed
    email="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ ! "$email" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z][a-z]+$ ]]; then
        echo "Skipping invalid email: '$raw'" >&2
        continue
    fi
    VALUES="${VALUES:+$VALUES,}('$email')"
    echo "Adding: $email"
done

if [[ -z "$VALUES" ]]; then
    echo "No valid emails to add." >&2
    exit 1
fi

# OR IGNORE: re-adding an existing tester keeps their original created_at
d1 "INSERT OR IGNORE INTO beta_testers (email) VALUES $VALUES;"

echo
echo "Current beta_testers:"
list_testers

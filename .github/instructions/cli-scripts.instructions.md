---
applyTo: "**"
description: "Script-first CLI rule — use scripts instead of inline Node/Python at the terminal. USE WHEN: running any Node.js or Python code, testing logic, inspecting data, or debugging with the terminal tool."
---

## Use Scripts, Not Inline CLI Code

**Never** pass inline code to the terminal via `-e`, `-c`, heredocs, or piped strings.

### Forbidden patterns

```bash
# ❌ Never do this
node -e "const data = require('./data/file.json'); console.log(data.items.length);"
python3 -c "import json; d = json.load(open('data.json')); print(d['key'])"
node << 'EOF'
  const x = require('./lib'); x.run();
EOF
```

### Required pattern

Create a script file first, then run it:

```bash
# ✅ Always do this
# 1. Create the script (e.g., scripts/inspect-data.js or a temp file like /tmp/check.js)
# 2. Run it
node /tmp/check.js
python3 /tmp/check.py
```

### Why

- Inline code fails silently on quote escaping, newlines, and special characters
- The agent almost always rewrites it as a script anyway after the first failure
- Scripts are easier to iterate on, debug, and re-run
- Script files are visible to the user for review

### Scope

This applies to all terminal commands using:

- `node -e` / `node -p`
- `python3 -c` / `python -c`
- Any heredoc piped to a runtime (`<< 'EOF'`)
- Multi-line `bash -c "..."` blocks containing logic

One-liner shell utilities (e.g., `grep`, `jq`, `awk`, `sed`) are fine inline.

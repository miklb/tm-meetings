# Pre-Commit Checklist

## Files to Stage for Commit

### Core Implementation

- [x] `lib/` - New HTTP scraper modules (498 + 296 lines)
  - `lib/http-meeting-scraper.js`
  - `lib/http-utils.js`
  - `lib/README.md`

### Modified Files

- [x] `json-scraper.js` - HTTP integration + --selenium flag
- [x] `docs/http-migration-checklist.md` - Updated task status

### Documentation

- [x] `docs/commit-summary.md` - This commit's documentation
- [x] `docs/priority1-completion-summary.md` - Initial work summary

### Test Data (Optional - for validation)

- [ ] `data/meeting_2608_2025-10-09.json` - HTTP scraper output example
- [ ] `agendas/agenda_2025-10-09.wp.html` - WordPress output example

## Files to Exclude from Commit

### Temporary Test Data

- `data/meeting_2666_2025-09-18.json` - Re-generated test file (redundant)
- `agendas/agenda_2608.wp.html` - Intermediate test file

### Already Committed

- `data/meeting_2666_2025-09-18.json` - Exists on main branch

## Files to Remove (Cleanup - Separate Commit Recommended)

### Superseded Code

- `http-scraper-spike.js` - Spike code now in `lib/http-meeting-scraper.js`
- `test-http-module.js` - Standalone test (now redundant)

### Debug/Test Output (Can be gitignored)

- `output/spike_*.html` - Old Selenium debug files
- `output/http_test_*.json` - Test output files
- `output/http_meeting_*.html` - HTTP debug files
- `output/http_agenda_*.html` - HTTP debug files

## Recommended Git Commands

### Stage Core Changes

```bash
# Add new lib directory
git add lib/

# Add modified files
git add json-scraper.js
git add docs/http-migration-checklist.md
git add docs/commit-summary.md
git add docs/priority1-completion-summary.md

# Optionally add test examples
git add data/meeting_2608_2025-10-09.json
git add agendas/agenda_2025-10-09.wp.html
```

### Reset Unwanted Changes

```bash
# Reset re-generated test file
git restore data/meeting_2666_2025-09-18.json

# Remove intermediate test file
rm agendas/agenda_2608.wp.html
```

### Commit

```bash
git commit -m "feat: HTTP-first scraper migration complete

- HTTP engine now default (3-5x faster than Selenium)
- Add lib/http-meeting-scraper.js with parallel processing (5 concurrent)
- Add lib/http-utils.js with shared utilities
- Integrate HTTP→JSON→WordPress pipeline with rawTitle field
- Add --selenium fallback flag for legacy behavior
- Suppress PDF parser warnings for cleaner output
- Validate end-to-end workflow with meeting 2608 (76 items)

Breaking Changes: None (backwards compatible)
Performance: ~2 min vs ~5-10 min (Selenium)
Testing: Meetings 2608 and 2666 validated"
```

## Future Cleanup (Separate PR)

### Remove Obsolete Files

```bash
git rm http-scraper-spike.js
git rm test-http-module.js
```

### Update .gitignore

```bash
# Add to .gitignore
output/spike_*.html
output/http_*.html
output/http_*.json
*.wp.html
```

## Validation Steps Before Commit

- [x] HTTP scraper works end-to-end (2608 tested)
- [x] WordPress conversion generates correct output
- [x] Date-based filenames working (agenda_2025-10-09.wp.html)
- [x] Staff reports integrated
- [x] Financial summaries calculated
- [x] --selenium fallback tested
- [x] Documentation complete
- [x] No breaking changes introduced

## Branch Strategy

**Current Branch**: `codex-refact`  
**Target**: Merge to `main` after 1-2 weeks production validation  
**Rollback Plan**: `--selenium` flag provides immediate fallback

---

**Ready to Commit**: ✅ Yes  
**Breaking Changes**: ❌ None  
**Production Ready**: ✅ Yes (with monitoring)

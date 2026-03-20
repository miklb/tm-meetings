# Accessibility Audit Report — Tampa Meetings Static Site

**Date:** March 20, 2026
**Standard:** WCAG 2.1 AA
**Tool:** pa11y 9.1.1 (HTML CodeSniffer) + manual review
**Pages tested:**

| Page                                | URL path          |
| ----------------------------------- | ----------------- |
| Homepage                            | `/`               |
| About                               | `/about/`         |
| Meeting detail (agenda only)        | `/meetings/2835/` |
| Meeting detail (video + transcript) | `/meetings/2821/` |
| Meeting detail (multi-part video)   | `/meetings/2672/` |

---

## Summary

| Severity    | Count | Category                                                                                                           |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| **Error**   | 3     | Contrast failures, missing h1, orphan ARIA roles                                                                   |
| **Warning** | 5     | Scrollable regions, new-window links, landmark usage, meta descriptions, heading skip                              |
| **Pass**    | 8     | Skip link, landmarks, focus management, tab pattern, noscript fallback, form labels, reduced-motion, semantic HTML |

---

## Errors (Must Fix)

### 1. Color Contrast Failures — `--color-text-muted` (`#8a8a82`)

**WCAG:** 1.4.3 Contrast (Minimum) — Level AA
**Severity:** Error
**Scope:** Site-wide

The `--color-text-muted` value `#8a8a82` fails WCAG AA 4.5:1 contrast on both background colours used on the site:

| Foreground             | Background          | Ratio  | Required | Result   |
| ---------------------- | ------------------- | ------ | -------- | -------- |
| `#8a8a82` (text-muted) | `#f1f1e6` (bg)      | 3.06:1 | 4.5:1    | **FAIL** |
| `#8a8a82` (text-muted) | `#f8f8f2` (surface) | 3.26:1 | 4.5:1    | **FAIL** |

**Affected elements** (every page):

- `.section-heading` — "Latest", "Previous Meetings" headings
- `.date-heading` — date group headings in the archive
- `.featured-date`, `.featured-meta` — meeting card metadata
- `.meeting-row-meta` — item count in list rows
- `.meeting-meta` — meeting date and item count on detail pages
- `.agenda-type` — "FINAL" / "DRAFT" badge on detail pages
- `.item-number` — agenda item numbers (1., 2., 3., …)
- `.doc-list-heading` — "Supporting Documents:" label
- `.item-background summary` — "Background Details" toggle text
- `.chapter-timestamp` — chapter time codes
- `.chapters-part-label` — "Part 1" / "Part 2" labels
- `.agenda-drawer__item-count` — item count in the drawer header
- `.video-tab__label` — video part labels on multi-part pages
- `.site-footer p` — footer disclaimer text

**Recommendation:** Darken `--color-text-muted` to at least `#706e66` (4.54:1 on `#f1f1e6`) or `#767468` (4.5:1 on `#f8f8f2`). A single value of `#6b6b63` works against both backgrounds at ≥ 4.5:1.

---

### 2. Missing `<h1>` on the Homepage

**WCAG:** 1.3.1 Info and Relationships — Level A
**Severity:** Error
**Scope:** Homepage only (`/`)

The homepage has no `<h1>` element. The heading hierarchy starts at `<h2>` ("Latest", "Previous Meetings"). Screen readers and assistive technologies expect an `<h1>` identifying the page purpose.

The site title link in the header (`<a class="site-title">Tampa City Council Meetings</a>`) is not a heading.

**Recommendation:** Either:

- Add a visually hidden `<h1 class="visually-hidden">Tampa City Council Meetings</h1>` inside `<main>`, or
- Make the existing site title an `<h1>` (common pattern for homepages)

---

### 3. Orphan `role="tabpanel"` on Single-Video Meeting Pages

**WCAG:** 4.1.2 Name, Role, Value — Level A
**Severity:** Error
**Scope:** Meeting pages with exactly one video (e.g., `/meetings/2821/`)

Single-video pages render a `<div role="tabpanel">` without a corresponding `role="tablist"` or `role="tab"`. This is semantically meaningless and may confuse screen readers that announce "tab panel" without any tab interface.

Multi-part video pages correctly include a full `role="tablist"` with `role="tab"` buttons, so the tabpanel role is appropriate there.

**Recommendation:** On single-video pages, omit `role="tabpanel"` (leave it as a plain `<div>`). Only emit the tab pattern when there are multiple videos.

---

## Warnings (Should Fix)

### 4. Scrollable Transcript Region Not Keyboard-Accessible

**WCAG:** 2.1.1 Keyboard — Level A
**Severity:** Warning
**Scope:** Meeting pages with transcripts

The `.transcript-body` `<div>` has `overflow-y: auto` (scrollable), but no `tabindex="0"`, meaning keyboard-only users cannot scroll the transcript content. The individual timestamp links within are focusable but the container itself is not scrollable via keyboard.

On desktop the transcript panel is a fixed-height scrollable area (via `max-height: calc(100vh - ...)`) making keyboard scrolling essential.

**Recommendation:** Add `tabindex="0"` and `role="region"` with an `aria-label` (e.g., "Meeting transcript text") to the `.transcript-body` container so keyboard users can focus and scroll it.

---

### 5. External Links Missing "Opens in New Window" Indication

**WCAG:** 3.2.5 Change on Request — Level AAA (advisory at AA)
**Severity:** Warning
**Scope:** All meeting detail pages

Meeting detail pages contain many `target="_blank"` links (64 on a typical page — OnBase links, document links, YouTube links) with no visual or accessible indication that they open in a new window/tab. While `rel="noopener noreferrer"` is correctly applied for security, screen reader users get no warning.

**Recommendation:** Either:

- Add visually hidden text: `<span class="visually-hidden">(opens in new tab)</span>` to external links, or
- Add an icon with `aria-label` indicating new window behaviour

---

### 6. `<div>` with `aria-label` Is Not a Landmark

**WCAG:** 1.3.1 Info and Relationships — Level A
**Severity:** Warning (low)
**Scope:** Meeting pages with video

The video player section uses `<div class="video-player-section" aria-label="Meeting video recordings">`. An `aria-label` on a `<div>` is ignored unless the element has a landmark role. Similarly, the transcript panel uses `<div class="transcript-panel" aria-label="Meeting transcript">`.

**Recommendation:** Change these to `<section>` elements. `<section>` with an `aria-label` creates a named landmark that screen readers can navigate to.

---

### 7. Missing `<meta name="description">` on All Pages

**WCAG:** Not directly a WCAG requirement
**Severity:** Warning (SEO/discoverability)
**Scope:** All pages

No page includes a `<meta name="description">` tag. While not a WCAG violation, this affects search engine accessibility and may impact how the site appears in search results, which is relevant to the civic transparency mission.

**Recommendation:** Add descriptions. For meeting pages: `"CRA meeting agenda, transcript, and video for March 12, 2026 — Tampa City Council"`.

---

### 8. Heading Level Skip: `<h3>` Without `<h2>` in Video Section

**WCAG:** 1.3.1 Info and Relationships — Level A
**Severity:** Warning
**Scope:** Meeting pages with video chapters

The chapters heading `<h3 class="chapters-heading">Chapters</h3>` appears inside the video panel without a preceding `<h2>` in that section. From the document outline perspective, the heading hierarchy jumps from `<h1>` (meeting title) to `<h3>` (Chapters), skipping `<h2>`.

The `<h2>` for "Agenda" exists but only in the noscript fallback or drawer, not as part of the main visible content flow alongside the transcript.

**Recommendation:** Either change the Chapters heading to `<h2>` or add a visually-hidden `<h2>` for the video section.

---

## Passing Areas (Good Practices Already in Place)

| Area                               | Details                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skip link**                      | Present on all pages (`<a class="skip-link" href="#main-content">Skip to content</a>`) with proper CSS hiding/showing on focus                              |
| **Semantic landmarks**             | `<header>`, `<nav aria-label="Primary">`, `<main id="main-content">`, `<footer>` correctly used on all pages                                                |
| **Language attribute**             | `<html lang="en">` set on all pages                                                                                                                         |
| **Agenda drawer accessibility**    | Excellent: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus trapping, Escape key closure, focus return to trigger, `aria-expanded` on trigger |
| **Video tab pattern (multi-part)** | Correct `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected`, `aria-controls`, `aria-labelledby`                                        |
| **Form labels**                    | Transcript search input has a proper `<label>` (visually hidden) with matching `for`/`id`                                                                   |
| **Noscript fallback**              | Video and agenda content both have `<noscript>` alternatives. YouTube embed has a `title` attribute                                                         |
| **Reduced motion**                 | `@media (prefers-reduced-motion: reduce)` disables transitions on the agenda drawer                                                                         |
| **Focus indicators**               | Buttons and links have `:focus-visible` styles. The search input has a custom focus outline                                                                 |
| **Image alt text**                 | Decorative thumbnails use `alt=""`. YouTube thumbnails are inside links that have text content                                                              |
| **`<time>` elements**              | Dates use `<time datetime="...">` throughout                                                                                                                |
| **`<details>`/`<summary>`**        | Background details use native disclosure pattern                                                                                                            |

---

## Recommended Fix Priority

| Priority | Issue                                                      | Effort                  |
| -------- | ---------------------------------------------------------- | ----------------------- |
| **P0**   | #1 — Contrast: darken `--color-text-muted`                 | 1 line CSS change       |
| **P0**   | #2 — Add `<h1>` to homepage                                | 1 line template change  |
| **P1**   | #3 — Remove orphan `role="tabpanel"` on single-video pages | Template conditional    |
| **P1**   | #4 — Add `tabindex="0"` to transcript scroll container     | 1 attribute in template |
| **P2**   | #6 — Change `div` to `section` for video/transcript panels | Template change         |
| **P2**   | #8 — Fix heading skip in chapters section                  | Template change         |
| **P3**   | #5 — Add new-window indication to external links           | Template/CSS change     |
| **P3**   | #7 — Add meta descriptions                                 | Template data/logic     |

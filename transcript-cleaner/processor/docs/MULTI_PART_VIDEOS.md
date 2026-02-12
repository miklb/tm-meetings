# Multi-Part Video Reference

This file contains YouTube URLs for all multi-part meetings to manually verify offsets.

## Meeting 2435 (2022-11-01) - Charter Workshop

**Transcript:** `data/transcripts/transcript_2435_2022-11-01.json` (or processed version)

### Part 1

- **Video ID:** JhLSLEN6AUc
- **Title:** TCC CHARTER WORKSHOP 11/1/22
- **URL:** https://www.youtube.com/watch?v=JhLSLEN6AUc
- **Duration:** PT3H12M37S (3h 12m 37s)
- **Auto Offset:** 284s (4:44) ✅ VERIFIED

### Part 2

- **Video ID:** \_hKmtK1vCBo
- **Title:** TCC CHARTER WORKSHOP 11/1/22 PT. 2
- **URL:** https://www.youtube.com/watch?v=_hKmtK1vCBo
- **Duration:** PT3H23M44S (3h 23m 44s)
- **Auto Offset:** -3503.8s (-58:24) ❌ NEEDS MANUAL VERIFICATION
- **Manual Offset:** \***\*295s (4:55)\*\*** (fill in after checking)

---

## Meeting 2436 (2022-11-03) - City Council

**Transcript:** `data/transcripts/transcript_2436_2022-11-03.json` (or processed version)

### Part 1

- **Video ID:** IYMsYZFCo8A
- **Title:** TCC 11/3/22
- **URL:** https://www.youtube.com/watch?v=IYMsYZFCo8A
- **Duration:** PT3H41S (3h 0m 41s)
- **Auto Offset:** -14s (-0:14) ✅ VERIFIED

### Part 2

- **Video ID:** CJWUphmVWbk
- **Title:** TCC 11/3/22 Pt.2
- **URL:** https://www.youtube.com/watch?v=CJWUphmVWbk
- **Duration:** PT1H21M47S (1h 21m 47s)
- **Auto Offset:** (not calculated)
- **Manual Offset:** \***\*0\*\*** (fill in after checking)

### Part 3

- **Video ID:** -Bf4zSEtjgA
- **Title:** TCC 11/3/22 Pt.3
- **URL:** https://www.youtube.com/watch?v=-Bf4zSEtjgA
- **Duration:** PT2H21M57S (2h 21m 57s)
- **Auto Offset:** -14s ❌ NEEDS MANUAL VERIFICATION (this can't be same as Part 1)
- **Manual Offset:** \***\*0\*\*** (fill in after checking)

---

## Meeting 2440 (2022-12-01 PM) - City Council

**Transcript:** `data/transcripts/transcript_2440_2022-12-01.json` (or processed version)

### Part 1 (ONLY PART)

- **Video ID:** EgGgLDJUnoM
- **Title:** TCC 12/1/22 PM
- **URL:** https://www.youtube.com/watch?v=EgGgLDJUnoM
- **Duration:** PT2H22M42S (2h 22m 42s)
- **Auto Offset:** 379.4s (6:19) ⚠️ Earlier calc was 390s (6:30)
- **Manual Offset:** \***\*389s (6:29)\*\*** (verify which is correct)

---

## Meeting 2445 (2023-01-05) - City Council

**Transcript:** `data/transcripts/transcript_2445_2023-01-05.json` (or processed version)

### Part 1

- **Video ID:** b9151AjHj2M
- **Title:** TCC 1/5/23
- **URL:** https://www.youtube.com/watch?v=b9151AjHj2M
- **Duration:** PT3H39M32S (3h 39m 32s)
- **Auto Offset:** -2202s (-36:42) ✅ VERIFIED

### Part 2

- **Video ID:** qsrhcMDkzcY
- **Title:** TCC 1/5/23 Pt.2
- **URL:** https://www.youtube.com/watch?v=qsrhcMDkzcY
- **Duration:** PT1H30M24S (1h 30m 24s)
- **Auto Offset:** 89.3s (1:29) ❌ NEEDS MANUAL VERIFICATION
- **Manual Offset:** \***\*65s (1:05)\*\*** (fill in after checking)

---

## Meeting 2450 (2023-01-19) - City Council

**Transcript:** `data/transcripts/transcript_2450_2023-01-19.json` (or processed version)

### Part 1

- **Video ID:** Q_m2dw8iHUs
- **Title:** TCC 1/19/23
- **URL:** https://www.youtube.com/watch?v=Q_m2dw8iHUs
- **Duration:** PT4H13M43S (4h 13m 43s)
- **Auto Offset:** 240s (4:00) ✅ VERIFIED

### Part 2

- **Video ID:** 91B0s36873Q
- **Title:** TCC AM 1/19/23 part 2 (Uploaded version)
- **URL:** https://www.youtube.com/watch?v=91B0s36873Q
- **Duration:** PT4H34M4S (4h 34m 4s)
- **Auto Offset:** 129.8s (2:10) ⚠️ NEEDS VERIFICATION
- **Manual Offset:** \***\*129.8s (2:10)\*\*** (fill in after checking)

---

## How to Verify Offsets

1. Open the video URL in YouTube
2. Open the transcript JSON file
3. Find the first few speaker segments in the transcript
4. Search for that text in the video (use YouTube's seek/scrub)
5. Note the video timestamp where transcript starts
6. Calculate offset: **video_timestamp_seconds - 0** (since transcript starts at 0)
7. Fill in the "Manual Offset" field above

### Example:

- Transcript first line: "Good morning, Council. We'll call this meeting to order."
- Found in video at timestamp: 4:30 (270 seconds)
- Offset = 270 seconds

### For Part 2+ Videos:

- Find where Part 2 starts in the TRANSCRIPT (e.g., after lunch break)
- Note that transcript timestamp (e.g., 3:15:00 in transcript = 11700s)
- Find the same text in Part 2 VIDEO
- Note that video timestamp (e.g., 0:08:30 in video = 510s)
- Offset = video_timestamp - transcript_timestamp = 510 - 11700 = -11190s

---

## Update Commands

After manually determining offsets, update the video_mapping files:

```bash
# Example for Meeting 2435 Part 2
# Edit data/video_mapping_2435.json and change offset_seconds for video _hKmtK1vCBo
```

Or use jq to update programmatically:

```bash
# Update offset for specific video in mapping file
jq '(.videos[] | select(.video_id == "_hKmtK1vCBo") | .offset_seconds) = 12345' \
  data/video_mapping_2435.json > tmp.json && mv tmp.json data/video_mapping_2435.json
```

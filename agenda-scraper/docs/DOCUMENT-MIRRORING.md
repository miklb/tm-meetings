# Document Mirroring Strategy

## Problem Statement

The City of Tampa's Hyland OnBase system generates document URLs that include a `publishId` parameter. When the city updates or republishes an agenda, this `publishId` changes, breaking all previously generated links.

**Example URL:**

```
https://tampagov.hylandcloud.com/221agendaonline/Documents/DownloadFileBytes/SUMMARY%20SHEET.PDF.pdf?documentType=1&meetingId=2650&itemId=19537&publishId=161658&isSection=False&isAttachment=True
```

When the agenda is republished, `publishId=161658` might become `publishId=162000`, and the old URL returns a 404.

## Proposed Solution: Document Mirroring

Mirror all supporting documents to an S3-compatible storage bucket, creating permanent, stable URLs that won't break regardless of changes in the source system.

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Agenda Scraper │────▶│  Document Mirror │────▶│   S3 Bucket     │
│  (existing)     │     │  (new module)    │     │   (CloudFlare   │
└─────────────────┘     └──────────────────┘     │    R2 / AWS)    │
        │                        │               └─────────────────┘
        │                        │                       │
        ▼                        ▼                       ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  meeting.json   │     │  Update URLs in  │     │  Permanent URLs │
│  (original URLs)│     │  JSON before WP  │     │  for WordPress  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

---

## Storage Options

### Recommended: Cloudflare R2

Based on actual data analysis (~268 MB/week, ~14 GB/year), **Cloudflare R2** is the optimal choice:

| Metric                       | Value                                 |
| ---------------------------- | ------------------------------------- |
| **Storage Cost**             | FREE first 10GB, then $0.015/GB/month |
| **Egress (downloads)**       | **FREE** (no bandwidth charges)       |
| **API Operations**           | 10M reads/month free                  |
| **Year 1 Cost**              | $0 (within free tier for ~9 months)   |
| **Annual Cost (after 10GB)** | ~$2.50/year                           |

**Why R2 wins:**

- Zero egress fees - critical for a public document mirror
- S3-compatible API - no code changes needed
- Free tier covers initial deployment
- Custom domain support with Cloudflare SSL
- Global edge caching via Cloudflare CDN

**Environment Variables:**

```env
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<r2_access_key>
S3_SECRET_ACCESS_KEY=<r2_secret_key>
S3_BUCKET=agenda-documents

# URL Configuration - choose one:

# Option 1: R2 dev URL (default, no custom domain needed)
S3_PUBLIC_URL=https://pub-XXXX.r2.dev

# Option 2: Custom domain (requires Cloudflare DNS)
# S3_PUBLIC_URL=https://docs.yoursite.com
# S3_CUSTOM_DOMAIN=true
```

**Setup Steps:**

1. Log into Cloudflare Dashboard → R2
2. Create bucket: `agenda-documents`
3. Settings → Public access → Enable (gives you a `pub-XXXX.r2.dev` URL)
4. R2 API Tokens → Create token with Object Read & Write
5. Copy Account ID, Access Key ID, and Secret Access Key to `.env`

**Custom Domain Setup (Optional):**

To use a custom domain like `docs.yoursite.com`:

1. **Move DNS to Cloudflare**: Your domain must use Cloudflare DNS
2. Go to R2 → Your bucket → Settings → Custom Domains
3. Add your subdomain (e.g., `docs.yoursite.com`)
4. Cloudflare will automatically configure the DNS CNAME
5. Update `.env`:
   ```env
   S3_PUBLIC_URL=https://docs.yoursite.com
   S3_CUSTOM_DOMAIN=true
   ```
6. Re-run `mirror-documents.js` to update URLs in JSON files

### Alternative Options

#### Vultr Object Storage

- **Cost**: $18/month for 1TB (overkill for ~14GB/year)
- **Best for**: If you need other Vultr services and want consolidated billing

#### Backblaze B2 + Cloudflare

- **Cost**: $0.006/GB storage (~$1/year), free egress via Cloudflare
- **Best for**: Maximum cost savings, slightly more complex setup

#### AWS S3

- **Cost**: ~$0.023/GB storage + $0.09/GB egress
- **Best for**: Enterprise environments already using AWS

---

## Naming Convention

Create a hierarchical, predictable URL structure:

```
s3://agenda-docs/
├── 2025-12-11/                    # Meeting date
│   ├── meeting-2650/              # Meeting ID
│   │   ├── 19527/                 # Agenda item ID
│   │   │   └── (no docs)
│   │   ├── 19528/
│   │   │   └── directors-report.pdf
│   │   └── 19537/
│   │       ├── ybor-resident-summary.pdf
│   │       ├── memo.pdf
│   │       └── presentation.pdf
│   └── meeting-2651/
│       └── ...
└── 2025-12-18/
    └── ...
```

**Public URL pattern:**

```
https://docs.yoursite.com/{date}/meeting-{meetingId}/{itemId}/{sanitized-filename}.pdf
```

---

## Implementation Plan

### Phase 1: Document Download Module

Create `lib/document-mirror.js`:

```javascript
/**
 * Document Mirror Module
 * Downloads and uploads supporting documents to S3-compatible storage
 */

const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const axios = require("axios");
const path = require("path");

class DocumentMirror {
  constructor(options = {}) {
    this.s3 = new S3Client({
      region: options.region || "auto",
      endpoint: options.endpoint || process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    this.bucket = options.bucket || process.env.S3_BUCKET;
    this.publicUrlBase = options.publicUrlBase || process.env.S3_PUBLIC_URL;
  }

  /**
   * Generate S3 key from document metadata
   */
  generateKey(meetingDate, meetingId, itemId, filename) {
    const sanitizedFilename = this.sanitizeFilename(filename);
    return `${meetingDate}/meeting-${meetingId}/${itemId}/${sanitizedFilename}`;
  }

  /**
   * Sanitize filename for S3
   */
  sanitizeFilename(filename) {
    return filename
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/\.pdf\.pdf$/, ".pdf") // Fix double extension
      .substring(0, 200); // Limit length
  }

  /**
   * Check if document already exists in S3
   */
  async exists(key) {
    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch (err) {
      if (err.name === "NotFound") return false;
      throw err;
    }
  }

  /**
   * Download document from OnBase and upload to S3
   */
  async mirrorDocument(sourceUrl, meetingDate, meetingId, itemId, filename) {
    const key = this.generateKey(meetingDate, meetingId, itemId, filename);

    // Skip if already mirrored
    if (await this.exists(key)) {
      console.log(`[Mirror] Already exists: ${key}`);
      return this.getPublicUrl(key);
    }

    // Download from OnBase
    console.log(`[Mirror] Downloading: ${filename}`);
    const response = await axios.get(sourceUrl, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent": "agenda-scraper-mirror/1.0",
      },
    });

    // Upload to S3
    console.log(`[Mirror] Uploading to: ${key}`);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: response.data,
        ContentType: this.getContentType(filename),
        CacheControl: "public, max-age=31536000", // 1 year cache
      })
    );

    return this.getPublicUrl(key);
  }

  /**
   * Get public URL for a mirrored document
   */
  getPublicUrl(key) {
    return `${this.publicUrlBase}/${key}`;
  }

  /**
   * Determine content type from filename
   */
  getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    return types[ext] || "application/octet-stream";
  }

  /**
   * Mirror all documents for a meeting
   */
  async mirrorMeeting(meetingData) {
    const results = {
      mirrored: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    const meetingDate = meetingData.formattedDate || meetingData.meetingDate;
    const meetingId = meetingData.meetingId;

    for (const item of meetingData.agendaItems) {
      if (!item.supportingDocuments || item.supportingDocuments.length === 0) {
        continue;
      }

      for (const doc of item.supportingDocuments) {
        try {
          const mirroredUrl = await this.mirrorDocument(
            doc.url,
            meetingDate,
            meetingId,
            item.agendaItemId,
            doc.title || doc.originalText
          );

          // Store the mirrored URL alongside the original
          doc.mirroredUrl = mirroredUrl;
          results.mirrored++;
        } catch (err) {
          console.error(`[Mirror] Failed: ${doc.title} - ${err.message}`);
          results.failed++;
          results.errors.push({
            document: doc.title,
            error: err.message,
          });
        }
      }
    }

    return results;
  }
}

module.exports = { DocumentMirror };
```

### Phase 2: Integration with Scraper

Update `json-scraper.js` or create a new `mirror-documents.js` CLI tool:

```javascript
#!/usr/bin/env node
/**
 * Mirror documents for a meeting to S3
 * Usage: node mirror-documents.js 2650
 */

const fs = require("fs");
const path = require("path");
const { DocumentMirror } = require("./lib/document-mirror");

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    console.error("Usage: node mirror-documents.js <meetingId>");
    process.exit(1);
  }

  // Find the JSON file
  const dataDir = path.join(__dirname, "data");
  const jsonFiles = fs
    .readdirSync(dataDir)
    .filter(
      (f) => f.startsWith(`meeting_${meetingId}_`) && f.endsWith(".json")
    );

  if (jsonFiles.length === 0) {
    console.error(`No JSON file found for meeting ${meetingId}`);
    process.exit(1);
  }

  const jsonPath = path.join(dataDir, jsonFiles[0]);
  const meetingData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  // Mirror documents
  const mirror = new DocumentMirror();
  console.log(`Mirroring documents for meeting ${meetingId}...`);

  const results = await mirror.mirrorMeeting(meetingData);

  console.log(`\nResults:`);
  console.log(`  Mirrored: ${results.mirrored}`);
  console.log(`  Skipped (already exists): ${results.skipped}`);
  console.log(`  Failed: ${results.failed}`);

  // Save updated JSON with mirrored URLs
  fs.writeFileSync(jsonPath, JSON.stringify(meetingData, null, 2));
  console.log(`\nUpdated ${jsonPath} with mirrored URLs`);
}

main().catch(console.error);
```

### Phase 3: Update WordPress Generator

Modify `json-to-wordpress.js` to prefer mirrored URLs:

```javascript
// In generateSingleMeetingMarkup, update the document URL logic:
item.supportingDocuments.forEach((doc) => {
  // Prefer mirrored URL if available, fall back to original
  const docUrl =
    doc.mirroredUrl ||
    (doc.url.startsWith("http")
      ? doc.url
      : "https://tampagov.hylandcloud.com" + doc.url);

  // ... rest of code
});
```

---

## Environment Variables

Add to `.env`:

```bash
# Cloudflare R2 (Recommended)
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=your_r2_access_key
S3_SECRET_ACCESS_KEY=your_r2_secret_key
S3_BUCKET=agenda-documents

# Public URL - choose one:
S3_PUBLIC_URL=https://pub-XXXX.r2.dev          # R2 dev URL (default)
# S3_PUBLIC_URL=https://docs.yoursite.com      # Custom domain
# S3_CUSTOM_DOMAIN=true                        # Required for custom domains

# Alternative: Vultr Object Storage
# S3_ENDPOINT=https://ewr1.vultrobjects.com
# S3_ACCESS_KEY_ID=your_vultr_access_key
# S3_SECRET_ACCESS_KEY=your_vultr_secret_key
# S3_BUCKET=agenda-docs
# S3_PUBLIC_URL=https://agenda-docs.ewr1.vultrobjects.com
```

### URL Format Differences

| URL Type      | `S3_CUSTOM_DOMAIN` | URL Pattern                             |
| ------------- | ------------------ | --------------------------------------- |
| R2 dev URL    | `false` (default)  | `https://pub-XXX.r2.dev/{bucket}/{key}` |
| Custom domain | `true`             | `https://docs.yoursite.com/{key}`       |

With custom domains, the bucket is implicit (the domain points to the bucket), so it's not included in the URL path.

### Vultr Object Storage Setup

1. Go to Vultr Dashboard → Products → Object Storage
2. Deploy new Object Storage in your preferred region (recommend same as your server)
3. Click on the storage instance to get credentials:
   - **Hostname**: `{region}.vultrobjects.com` (e.g., `ewr1.vultrobjects.com`)
   - **Access Key**: Your S3 access key
   - **Secret Key**: Your S3 secret key
4. Create a bucket named `agenda-docs` via the dashboard or AWS CLI
5. Set bucket to **public read** for document access

```bash
# Using AWS CLI with Vultr
aws configure --profile vultr
# Enter your Vultr access key and secret

# Create bucket
aws --profile vultr --endpoint-url https://ewr1.vultrobjects.com s3 mb s3://agenda-docs

# Set public read policy
aws --profile vultr --endpoint-url https://ewr1.vultrobjects.com s3api put-bucket-acl \
  --bucket agenda-docs --acl public-read
```

---

## Workflow Integration

### Option A: Mirror During Scrape

Add mirroring as part of the scraping process:

```bash
# Scrape and mirror in one step
node json-scraper.js 2650 --mirror
```

### Option B: Separate Mirroring Step

Keep scraping and mirroring separate for flexibility:

```bash
# Step 1: Scrape agenda
node json-scraper.js 2650

# Step 2: Mirror documents
node mirror-documents.js 2650

# Step 3: Generate WordPress markup
node json-to-wordpress.js 2650
```

### Option C: Batch Processing

Mirror all documents for a date range:

```bash
node mirror-documents.js --date 2025-12-11
```

---

## Cost Estimation

### Document Volume

Assuming per meeting:

- 70 agenda items average
- 1.5 documents per item average
- 500KB average document size

**Per meeting**: ~105 documents × 500KB = ~52MB
**Per month** (8 meetings): ~420MB
**Per year**: ~5GB

### Storage Costs (Cloudflare R2)

- Free tier: 10GB storage, 10M reads
- **Estimated annual cost**: $0 (within free tier)

### Alternative: AWS S3

- Storage: 5GB × $0.023 = $0.12/month
- Requests: ~1000/month × $0.0004 = $0.40/month
- **Estimated annual cost**: ~$6/year + egress

### Vultr Object Storage

- **Cost**: $18/month for 1TB (Standard tier) - may be overkill for document mirroring alone
- Consider Cloudflare R2 if you only need document storage

---

## Deduplication Strategy

Many documents appear across multiple agenda items or meetings. Consider:

1. **Content-based hashing**: Generate SHA-256 hash of file content
2. **Store hash mapping**: Map original URLs to content hashes
3. **Single copy storage**: Store each unique file once, create symlinks/redirects

```javascript
async mirrorDocumentDeduplicated(sourceUrl, ...args) {
  const response = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
  const hash = crypto.createHash('sha256').update(response.data).digest('hex');

  const hashKey = `by-hash/${hash.substring(0, 2)}/${hash}.pdf`;

  // Check if content already exists
  if (await this.exists(hashKey)) {
    // Just return URL, content already stored
    return this.getPublicUrl(hashKey);
  }

  // Upload to hash-based location
  await this.upload(hashKey, response.data);
  return this.getPublicUrl(hashKey);
}
```

---

## Migration Plan

1. **Week 1**: Implement document mirror module, test with R2/S3
2. **Week 2**: Mirror existing historical documents (backfill)
3. **Week 3**: Integrate into scraping workflow
4. **Week 4**: Update WordPress generation to use mirrored URLs
5. **Ongoing**: Update existing WordPress posts with new URLs (optional)

---

## Fallback Strategy

If mirrored URL fails, fall back to original:

```javascript
// Client-side fallback (add to WordPress theme)
document.querySelectorAll("a[data-original-url]").forEach((link) => {
  link.addEventListener("error", function () {
    this.href = this.dataset.originalUrl;
  });
});
```

Or generate links with fallback:

```html
<a
  href="https://docs.yoursite.com/..."
  data-original-url="https://tampagov.hylandcloud.com/..."
>
  Document Name
</a>
```

---

## Monitoring & Alerts

Consider adding:

- Webhook/notification when mirroring fails
- Daily job to verify document accessibility
- Alert when storage approaches limits

---

## Security Considerations

1. **Public read access**: Documents are public records, OK for public bucket
2. **Write access**: Keep credentials secure, rotate regularly
3. **CORS**: Configure for your WordPress domain
4. **Rate limiting**: Respect OnBase rate limits during download

---

## Next Steps

1. Choose storage provider (recommend Cloudflare R2 for free egress)
2. Create bucket and configure public access
3. Implement `lib/document-mirror.js`
4. Test with a single meeting
5. Integrate into workflow
6. Backfill historical documents

---

## Questions to Consider

1. **Retention policy**: How long to keep mirrored documents?
2. **Versioning**: Track when city updates a document?
3. **Full agenda PDF**: Also mirror the main agenda document?
4. **Backfill priority**: Which historical meetings to mirror first?

/**
 * Document Mirror Module
 * Downloads supporting documents from OnBase and uploads to S3-compatible storage
 * to create permanent, stable URLs that won't break when publishId changes.
 */

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

class DocumentMirror {
  /**
   * Create a new DocumentMirror instance
   * @param {Object} options - Configuration options
   * @param {string} options.endpoint - S3 endpoint URL
   * @param {string} options.region - S3 region (default: 'auto')
   * @param {string} options.bucket - S3 bucket name
   * @param {string} options.publicUrlBase - Base URL for public access
   * @param {string} options.accessKeyId - S3 access key
   * @param {string} options.secretAccessKey - S3 secret key
   */
  constructor(options = {}) {
    const endpoint = options.endpoint || process.env.S3_ENDPOINT;
    const accessKeyId = options.accessKeyId || process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = options.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('Missing required S3 configuration. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY');
    }

    this.s3 = new S3Client({
      region: options.region || 'auto',
      endpoint: endpoint,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
      forcePathStyle: true, // Required for most S3-compatible services
    });

    this.bucket = options.bucket || process.env.S3_BUCKET || 'agenda-docs';
    this.publicUrlBase = options.publicUrlBase || process.env.S3_PUBLIC_URL || endpoint;
    
    // For custom domains, the bucket is implicit in the domain (set S3_CUSTOM_DOMAIN=true)
    // For R2 dev URLs (pub-XXX.r2.dev), the bucket must be in the path
    this.includeBucketInUrl = options.includeBucketInUrl ?? 
      (process.env.S3_CUSTOM_DOMAIN !== 'true');
    
    // Remove trailing slash from public URL base
    this.publicUrlBase = this.publicUrlBase.replace(/\/$/, '');
  }

  /**
   * Generate S3 key from document metadata
   * @param {string} meetingDate - Meeting date (YYYY-MM-DD format)
   * @param {string} meetingId - Meeting ID
   * @param {string} itemId - Agenda item ID
   * @param {string} filename - Original filename
   * @returns {string} S3 object key
   */
  generateKey(meetingDate, meetingId, itemId, filename) {
    const sanitizedFilename = this.sanitizeFilename(filename);
    return `${meetingDate}/meeting-${meetingId}/${itemId}/${sanitizedFilename}`;
  }

  /**
   * Sanitize filename for S3 storage
   * @param {string} filename - Original filename
   * @returns {string} Sanitized filename
   */
  sanitizeFilename(filename) {
    if (!filename) return 'document.pdf';
    
    let sanitized = filename
      .toLowerCase()
      .replace(/\s+/g, '-')           // Replace spaces with hyphens
      .replace(/[()]/g, '')           // Remove parentheses
      .replace(/[^a-z0-9._-]/g, '')   // Remove special characters
      .replace(/\.pdf\.pdf$/i, '.pdf') // Fix double .pdf extension
      .replace(/\.docx?\.pdf$/i, '.pdf') // Fix .doc.pdf or .docx.pdf
      .replace(/-+/g, '-')            // Collapse multiple hyphens
      .replace(/^-|-$/g, '')          // Remove leading/trailing hyphens
      .substring(0, 200);             // Limit length

    // If no file extension, default to .pdf (most OnBase documents are PDFs)
    if (!path.extname(sanitized)) {
      sanitized += '.pdf';
    }

    return sanitized;
  }

  /**
   * Check if document already exists in S3
   * @param {string} key - S3 object key
   * @returns {Promise<boolean>} True if exists
   */
  async exists(key) {
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get content type based on filename extension
   * @param {string} filename - Filename
   * @returns {string} MIME type
   */
  getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
    };
    return types[ext] || 'application/octet-stream';
  }

  /**
   * Get public URL for a mirrored document
   * @param {string} key - S3 object key
   * @returns {string} Public URL
   */
  getPublicUrl(key) {
    if (this.includeBucketInUrl) {
      return `${this.publicUrlBase}/${this.bucket}/${key}`;
    }
    return `${this.publicUrlBase}/${key}`;
  }

  /**
   * Download document from source URL
   * @param {string} url - Source URL
   * @returns {Promise<Buffer>} Document content
   */
  async downloadDocument(url) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000, // 2 minute timeout for large documents
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      headers: {
        'User-Agent': 'agenda-scraper-mirror/1.0',
        'Accept': '*/*',
      },
    });
    return Buffer.from(response.data);
  }

  /**
   * Upload document to S3
   * @param {string} key - S3 object key
   * @param {Buffer} content - Document content
   * @param {string} contentType - MIME type
   * @returns {Promise<void>}
   */
  async uploadDocument(key, content, contentType) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000', // 1 year cache (documents don't change)
      ACL: 'public-read',
    }));
  }

  /**
   * Mirror a single document from OnBase to S3
   * @param {string} sourceUrl - Original OnBase URL
   * @param {string} meetingDate - Meeting date (YYYY-MM-DD)
   * @param {string} meetingId - Meeting ID
   * @param {string} itemId - Agenda item ID
   * @param {string} filename - Document filename
   * @param {Object} options - Additional options
   * @param {boolean} options.force - Force re-upload even if exists
   * @returns {Promise<Object>} Result with mirroredUrl and status
   */
  async mirrorDocument(sourceUrl, meetingDate, meetingId, itemId, filename, options = {}) {
    const key = this.generateKey(meetingDate, meetingId, itemId, filename);
    const publicUrl = this.getPublicUrl(key);

    // Check if already mirrored (unless force=true)
    if (!options.force && await this.exists(key)) {
      return {
        status: 'exists',
        key,
        mirroredUrl: publicUrl,
        sourceUrl,
      };
    }

    // Download from OnBase
    const content = await this.downloadDocument(sourceUrl);
    
    // Calculate content hash for logging/deduplication
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 12);

    // Upload to S3 — derive content type from the sanitized key (which has a guaranteed extension)
    const contentType = this.getContentType(key);
    await this.uploadDocument(key, content, contentType);

    return {
      status: 'uploaded',
      key,
      mirroredUrl: publicUrl,
      sourceUrl,
      size: content.length,
      hash,
      contentType,
    };
  }

  /**
   * Mirror all documents for a single agenda item
   * @param {Object} item - Agenda item object
   * @param {string} meetingDate - Meeting date (YYYY-MM-DD)
   * @param {string} meetingId - Meeting ID
   * @param {Object} options - Mirror options
   * @returns {Promise<Object>} Results summary
   */
  async mirrorItemDocuments(item, meetingDate, meetingId, options = {}) {
    const results = {
      itemId: item.agendaItemId,
      itemNumber: item.number,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      documents: [],
    };

    if (!item.supportingDocuments || item.supportingDocuments.length === 0) {
      return results;
    }

    for (const doc of item.supportingDocuments) {
      const filename = doc.title || doc.originalText || 'document.pdf';
      
      try {
        const result = await this.mirrorDocument(
          doc.url,
          meetingDate,
          meetingId,
          item.agendaItemId,
          filename,
          options
        );

        // Store mirrored URL on the document object
        doc.mirroredUrl = result.mirroredUrl;

        if (result.status === 'uploaded') {
          results.uploaded++;
          console.log(`  ✓ Uploaded: ${filename} (${this.formatBytes(result.size)})`);
        } else {
          results.skipped++;
          console.log(`  ○ Exists: ${filename}`);
        }

        results.documents.push({
          filename,
          status: result.status,
          mirroredUrl: result.mirroredUrl,
        });

      } catch (err) {
        results.failed++;
        console.error(`  ✗ Failed: ${filename} - ${err.message}`);
        
        results.documents.push({
          filename,
          status: 'failed',
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * Mirror all documents for an entire meeting
   * @param {Object} meetingData - Full meeting data object
   * @param {Object} options - Mirror options
   * @param {boolean} options.force - Force re-upload all documents
   * @param {number} options.concurrency - Number of concurrent uploads (default: 3)
   * @returns {Promise<Object>} Results summary
   */
  async mirrorMeeting(meetingData, options = {}) {
    const concurrency = options.concurrency || 3;
    
    // Get meeting date in YYYY-MM-DD format
    const meetingDate = meetingData.formattedDate || this.formatDate(meetingData.meetingDate);
    const meetingId = meetingData.meetingId;

    console.log(`\nMirroring documents for meeting ${meetingId} (${meetingDate})`);
    console.log('='.repeat(60));

    const results = {
      meetingId,
      meetingDate,
      totalItems: meetingData.agendaItems.length,
      itemsWithDocs: 0,
      totalDocuments: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    // Count total documents
    for (const item of meetingData.agendaItems) {
      if (item.supportingDocuments && item.supportingDocuments.length > 0) {
        results.itemsWithDocs++;
        results.totalDocuments += item.supportingDocuments.length;
      }
    }

    console.log(`Found ${results.totalDocuments} documents across ${results.itemsWithDocs} items\n`);

    // Process items with rate limiting
    for (const item of meetingData.agendaItems) {
      if (!item.supportingDocuments || item.supportingDocuments.length === 0) {
        continue;
      }

      console.log(`Item ${item.number}: ${item.fileNumber || 'No file number'}`);
      
      const itemResults = await this.mirrorItemDocuments(item, meetingDate, meetingId, options);
      
      results.uploaded += itemResults.uploaded;
      results.skipped += itemResults.skipped;
      results.failed += itemResults.failed;

      // Collect errors
      for (const doc of itemResults.documents) {
        if (doc.status === 'failed') {
          results.errors.push({
            itemNumber: item.number,
            document: doc.filename,
            error: doc.error,
          });
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log(`  Uploaded: ${results.uploaded}`);
    console.log(`  Already existed: ${results.skipped}`);
    console.log(`  Failed: ${results.failed}`);

    if (results.errors.length > 0) {
      console.log('\nErrors:');
      for (const err of results.errors) {
        console.log(`  Item ${err.itemNumber}: ${err.document} - ${err.error}`);
      }
    }

    return results;
  }

  /**
   * Format date string to YYYY-MM-DD
   * @param {string} dateStr - Date string like "December 11, 2025"
   * @returns {string} Formatted date
   */
  formatDate(dateStr) {
    if (!dateStr) return 'unknown-date';
    
    // If already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return 'unknown-date';
      }
      return date.toISOString().split('T')[0];
    } catch {
      return 'unknown-date';
    }
  }

  /**
   * Format bytes to human-readable string
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = { DocumentMirror };

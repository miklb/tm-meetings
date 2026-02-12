# Tampa City Council Agenda JSON Schema

## Overview

This document describes the structure of Tampa City Council agenda JSON files used for entity extraction and ML training.

## Data Range

- **Total Meetings**: 23
- **Date Range**: July 31, 2025 to November 6, 2025 (98 days)
- **Distribution**:
  - July 2025: 2 meetings
  - August 2025: 6 meetings
  - September 2025: 8 meetings
  - October 2025: 6 meetings
  - November 2025: 1 meeting

## Meeting Types

The meeting types have been standardized to use consistent naming:

- **Council Regular**: 9 meetings (regular business sessions)
- **Council Evening**: 9 meetings (evening sessions)
- **Council Workshop**: 2 meetings (workshop sessions)
- **CRA Regular**: 2 meetings (Community Redevelopment Agency)
- **Council Special**: 1 meeting (special called session)

## File Naming Convention

```
meeting_{meetingId}_{date}.json
```

**Examples:**

- `meeting_2665_2025-10-23.json`
- `meeting_2516_2025-08-28.json`

Where:

- `{meetingId}`: Numeric ID from Tampa Gov system (e.g., "2665")
- `{date}`: ISO 8601 date format (YYYY-MM-DD)

## JSON Structure

### Root Level

```json
{
  "meetingId": "string",           // Unique meeting identifier
  "meetingType": "string",         // Type of meeting (see Meeting Types above)
  "meetingDate": "string",         // Human-readable date (e.g., "October 23, 2025")
  "sourceUrl": "string",           // URL to official agenda on Tampa Gov site
  "agendaItems": [...]             // Array of agenda items (see below)
}
```

### Agenda Item Structure

Each agenda item contains detailed information about topics discussed:

```json
{
  "number": 1,                     // Sequential item number
  "agendaItemId": "string",        // Unique item identifier
  "title": "string",               // Full item title with file number
  "rawTitle": "string",            // Original title text
  "fileNumber": "string",          // File reference (e.g., "BA25-17034")
  "background": "string",          // Detailed background/context
  "supportingDocuments": [...],    // Array of document links (see below)
  "dollarAmounts": [...],          // Array of financial amounts mentioned
  "financialDetails": [...],       // Detailed financial information
  "financialTotals": {...}         // Aggregated financial totals (see below)
}
```

### Supporting Documents

Documents attached to agenda items:

```json
{
  "title": "string", // Document title
  "url": "string", // Download URL
  "originalTitle": "string", // Original link text
  "originalText": "string" // Original anchor text
}
```

### Dollar Amounts

Financial amounts extracted from agenda text:

```json
{
  "amount": "string", // Dollar amount (e.g., "$85,749")
  "context": "string", // Surrounding text for context
  "rawAmount": "string" // Raw text extracted
}
```

### Financial Details

Structured financial information:

```json
{
  "type": "string",               // "expenditure", "revenue", "decrease", etc.
  "amount": number,               // Numeric amount
  "description": "string"         // Description of financial item
}
```

### Financial Totals

Aggregated totals per agenda item:

```json
{
  "expenditures": number,         // Total expenditures
  "decreases": number,            // Total decreases
  "revenues": number,             // Total revenues
  "other": number,                // Other amounts
  "net": number                   // Net total
}
```

## Entity Types Found

Based on analysis of the agenda JSON files, the following entity types are commonly found:

### 1. People

- **Appointees**: Sul Hemani, etc.
- **Council Members**: Referenced in meeting context
- **Staff Members**: Department heads, presenters
- **Public Speakers**: Community members

### 2. Organizations

- **City Departments**:
  - Tampa Police Department (TPD)
  - Tampa Fire Department (TFD)
  - Housing and Community Development
  - IT Department
- **External Organizations**:

  - Tampa Housing Authority (THA)
  - HART (Hillsborough Area Regional Transit)
  - TECO (Tampa Electric Company)
  - Teledyne Flir Defense
  - Fisher Scientific

- **Government Bodies**:
  - City Council
  - Community Redevelopment Agency (CRA)

### 3. Geographic Locations

- **Neighborhoods**: Ybor City, Hyde Park, Seminole Heights, etc.
- **Streets/Addresses**: "1616 East 7th Avenue", etc.
- **Cities**: Tampa, Atlanta, New York, Mobile
- **Features**: Tampa Bay, Hillsborough River

### 4. Products/Equipment

- Star Safire 380HDc
- FLIR Defense System
- Laboratory equipment
- Technical products

### 5. File Numbers

- Format: `{TYPE}{YY}-{NUMBER}`
- Examples: `BA25-17034`, `PS25-18003`, `INF25-18031`
- Types: BA (Board Appointment), PS (Purchase/Services), INF (Information)

### 6. Resolution Numbers

- Format: `Resolution No. {YEAR}-{NUMBER}`
- Example: `Resolution No. 2021-173`

### 7. Financial Amounts

- Currency values: `$85,749`, `$28,583`
- Often include context about:
  - Contracts
  - Purchases
  - Budget allocations
  - Vendor agreements

### 8. Acronyms

- **Government**: CRA, THA, EBO (Emerging Business Opportunities)
- **Transit**: HART, TECO
- **Technical**: ADA (Americans with Disabilities Act), WCAG (Web Content Accessibility Guidelines)
- **Emergency Services**: TPD, TFD, EMS
- **Technology**: IT, PDF, HTML, API
- **Military/Equipment**: FLIR (Forward Looking Infrared)

## Common Patterns

### File Number Patterns

```
BA{YY}-{#####}    # Board Appointments
PS{YY}-{#####}    # Purchases/Services
INF{YY}-{#####}   # Information items
ORD{YY}-{#####}   # Ordinances
RES{YY}-{#####}   # Resolutions
```

### Name Patterns

- **Irish/Scottish**: O'Brien, O'Donnell, McDonald, MacDonald
- **Multiple words**: Sul Hemani, Bill Carlson
- **Titles**: Mayor, Council Member, Chief, Director

### Address Patterns

- Street addresses with cardinal directions: "1616 East 7th Avenue"
- Intersections: "Dale Mabry Highway and MLK Boulevard"

## Usage for Entity Extraction

### Priority Entities (High Value)

1. **People**: Names of officials, appointees, speakers
2. **Organizations**: Companies, departments, agencies
3. **Dollar Amounts**: Financial information
4. **File Numbers**: For cross-referencing
5. **Acronyms**: With expansions for dictionary building

### Secondary Entities

1. Geographic locations
2. Product names
3. Resolution numbers
4. Dates and times

## Data Quality Notes

- ✅ All files contain valid JSON
- ✅ meetingId and meetingDate always present
- ✅ agendaItems is an array (can be empty)
- ✅ meetingType is now standardized across all files
- ⚠️ Some agenda items have no financial data (empty arrays/objects)
- ℹ️ Background text is rich source for entity extraction
- ℹ️ Dollar amounts are pre-extracted where possible

## Example Usage

See `src/entity_extractor.py` for implementation of parsing these files.

## Metadata File

A metadata summary is available at `data/meetings_metadata.json` containing:

- List of all meetings with dates and IDs
- Coverage statistics
- Meeting type distribution
- Quick reference for batch processing

## Updates

This schema reflects the structure as of November 2025. The Tampa Gov system may evolve over time, requiring schema updates.

---

**Generated**: November 1, 2025  
**Source**: Tampa City Council Agenda Online System  
**URL**: https://tampagov.hylandcloud.com/221agendaonline/

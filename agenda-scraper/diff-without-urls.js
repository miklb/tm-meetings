#!/usr/bin/env node

/**
 * Compare two meeting JSON files and show differences excluding URL changes
 * Usage: node diff-without-urls.js <file1> <file2>
 * Or: git show HEAD:path/to/file.json | node diff-without-urls.js - path/to/file.json
 */

const fs = require('fs');

function deepEqual(obj1, obj2, path = '') {
  const diffs = [];
  
  if (obj1 === obj2) return diffs;
  
  if (typeof obj1 !== typeof obj2) {
    diffs.push({ path, type: 'type_change', old: typeof obj1, new: typeof obj2 });
    return diffs;
  }
  
  if (obj1 === null || obj2 === null) {
    if (obj1 !== obj2) {
      diffs.push({ path, type: 'value_change', old: obj1, new: obj2 });
    }
    return diffs;
  }
  
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) {
      diffs.push({ 
        path, 
        type: 'array_length_change', 
        old: obj1.length, 
        new: obj2.length 
      });
      
      // Show added items
      if (obj2.length > obj1.length) {
        for (let i = obj1.length; i < obj2.length; i++) {
          diffs.push({
            path: `${path}[${i}]`,
            type: 'array_item_added',
            value: obj2[i]
          });
        }
      }
    }
    
    const minLen = Math.min(obj1.length, obj2.length);
    for (let i = 0; i < minLen; i++) {
      diffs.push(...deepEqual(obj1[i], obj2[i], `${path}[${i}]`));
    }
    
    return diffs;
  }
  
  if (typeof obj1 === 'object' && typeof obj2 === 'object') {
    const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
    
    for (const key of allKeys) {
      // Skip URL fields - this is the key filter
      if (key === 'url' && obj1[key] && obj2[key]) {
        // Only report if URL changed AND title also changed (new document)
        // Otherwise skip URL-only changes
        continue;
      }
      
      const newPath = path ? `${path}.${key}` : key;
      
      if (!(key in obj1)) {
        diffs.push({ path: newPath, type: 'field_added', value: obj2[key] });
      } else if (!(key in obj2)) {
        diffs.push({ path: newPath, type: 'field_removed', value: obj1[key] });
      } else {
        diffs.push(...deepEqual(obj1[key], obj2[key], newPath));
      }
    }
    
    return diffs;
  }
  
  if (obj1 !== obj2) {
    diffs.push({ path, type: 'value_change', old: obj1, new: obj2 });
  }
  
  return diffs;
}

function formatDiff(diff, summary = false) {
  if (summary) {
    return formatSummary(diff);
  }
  
  const lines = [];
  
  for (const d of diff) {
    switch (d.type) {
      case 'value_change':
        lines.push(`\n📝 Changed: ${d.path}`);
        lines.push(`   Old: ${typeof d.old === 'string' && d.old.length > 100 ? d.old.substring(0, 100) + '...' : d.old}`);
        lines.push(`   New: ${typeof d.new === 'string' && d.new.length > 100 ? d.new.substring(0, 100) + '...' : d.new}`);
        break;
        
      case 'field_added':
        lines.push(`\n➕ Added: ${d.path}`);
        if (typeof d.value === 'object') {
          lines.push(`   Value: ${JSON.stringify(d.value, null, 2).substring(0, 200)}...`);
        } else {
          lines.push(`   Value: ${d.value}`);
        }
        break;
        
      case 'field_removed':
        lines.push(`\n➖ Removed: ${d.path}`);
        break;
        
      case 'array_length_change':
        lines.push(`\n📊 Array length changed: ${d.path}`);
        lines.push(`   Old: ${d.old} items`);
        lines.push(`   New: ${d.new} items`);
        break;
        
      case 'array_item_added':
        lines.push(`\n➕ Array item added: ${d.path}`);
        if (typeof d.value === 'object') {
          lines.push(`   ${JSON.stringify(d.value, null, 2)}`);
        } else {
          lines.push(`   ${d.value}`);
        }
        break;
        
      case 'type_change':
        lines.push(`\n⚠️  Type changed: ${d.path}`);
        lines.push(`   Old: ${d.old}`);
        lines.push(`   New: ${d.new}`);
        break;
    }
  }
  
  return lines.join('\n');
}

function formatSummary(diffs) {
  const itemChanges = new Map();
  const globalChanges = [];
  
  for (const d of diffs) {
    const path = d.path;
    
    // Check if it's an agendaItem change
    const itemMatch = path.match(/^agendaItems\[(\d+)\]\.?(.+)?/);
    
    if (itemMatch) {
      const itemIndex = parseInt(itemMatch[1]);
      const field = itemMatch[2] || '';
      
      if (!itemChanges.has(itemIndex)) {
        itemChanges.set(itemIndex, {
          fields: new Set(),
          newDocs: 0,
          changes: []
        });
      }
      
      const item = itemChanges.get(itemIndex);
      
      if (field.includes('supportingDocuments') && d.type === 'array_item_added') {
        item.newDocs++;
        if (d.value && d.value.title) {
          item.changes.push(`  - New document: ${d.value.title}`);
        }
      } else if (field.includes('title')) {
        item.fields.add('title');
      } else if (field.includes('background')) {
        item.fields.add('background');
      } else if (field.includes('summary')) {
        item.fields.add('summary');
      } else if (field) {
        item.fields.add(field.split('.')[0]);
      }
    } else {
      // Global change (not in an agendaItem)
      globalChanges.push({ path, type: d.type });
    }
  }
  
  const lines = ['# Changes Summary\n'];
  
  if (globalChanges.length > 0) {
    lines.push('## Global Changes');
    for (const change of globalChanges) {
      lines.push(`- ${change.path}`);
    }
    lines.push('');
  }
  
  if (itemChanges.size > 0) {
    lines.push('## Agenda Items Changed\n');
    
    const sortedItems = Array.from(itemChanges.entries()).sort((a, b) => a[0] - b[0]);
    
    for (const [itemIndex, info] of sortedItems) {
      const fields = Array.from(info.fields);
      let summary = `**Item #${itemIndex}**`;
      
      if (info.newDocs > 0) {
        summary += ` - ${info.newDocs} new document${info.newDocs > 1 ? 's' : ''}`;
      }
      if (fields.length > 0) {
        summary += ` - Modified: ${fields.join(', ')}`;
      }
      
      lines.push(summary);
      
      if (info.changes.length > 0) {
        lines.push(...info.changes);
      }
      lines.push('');
    }
  }
  
  return lines.join('\n');
}

// Main
const args = process.argv.slice(2);

// Check for flags
const summaryMode = args.includes('--summary') || args.includes('-s');
const filteredArgs = args.filter(arg => !arg.startsWith('-'));

if (filteredArgs.length < 2) {
  console.error('Usage: node diff-without-urls.js [--summary|-s] <old-file> <new-file>');
  console.error('   or: git show HEAD:file.json | node diff-without-urls.js [--summary|-s] - file.json');
  console.error('\nOptions:');
  console.error('  --summary, -s    Show simplified summary with item numbers only');
  process.exit(1);
}

let oldData, newData;

try {
  if (filteredArgs[0] === '-') {
    // Read from stdin (piped git show)
    const stdin = fs.readFileSync(0, 'utf-8');
    oldData = JSON.parse(stdin);
  } else {
    oldData = JSON.parse(fs.readFileSync(filteredArgs[0], 'utf-8'));
  }
  
  newData = JSON.parse(fs.readFileSync(filteredArgs[1], 'utf-8'));
  
  const diffs = deepEqual(oldData, newData);
  
  if (diffs.length === 0) {
    console.log('✅ No meaningful changes (URL-only changes ignored)');
  } else {
    if (summaryMode) {
      console.log(formatDiff(diffs, true));
    } else {
      console.log(`\n🔍 Found ${diffs.length} meaningful changes:\n`);
      console.log(formatDiff(diffs));
    }
  }
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

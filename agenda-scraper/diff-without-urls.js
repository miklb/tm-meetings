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

function formatDiff(diff) {
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

function formatSummary(oldData, newData) {
  const lines = [];
  let urlOnlyCount = 0;
  let hasMeaningfulChange = false;

  // 1. agendaType change
  if (oldData.agendaType !== newData.agendaType) {
    hasMeaningfulChange = true;
    lines.push(`**Agenda type:** ${oldData.agendaType} → ${newData.agendaType}\n`);
  }

  // 2. Agenda items added/removed by stable agendaItemId
  const oldItems = oldData.agendaItems || [];
  const newItems = newData.agendaItems || [];
  const oldById = new Map(oldItems.map(i => [i.agendaItemId, i]));
  const newById = new Map(newItems.map(i => [i.agendaItemId, i]));
  const addedIds = [...newById.keys()].filter(id => !oldById.has(id));
  const removedIds = [...oldById.keys()].filter(id => !newById.has(id));

  if (addedIds.length > 0 || removedIds.length > 0 || oldItems.length !== newItems.length) {
    hasMeaningfulChange = true;
    const countPart = oldItems.length !== newItems.length
      ? `${oldItems.length} → ${newItems.length}`
      : `${newItems.length}`;
    const addedPart = addedIds.length > 0
      ? addedIds.map(id => {
          const item = newById.get(id);
          const label = item && item.fileNumber ? `${item.fileNumber} (${id})` : id;
          return `added ${label}`;
        }).join(', ')
      : '';
    const removedPart = removedIds.length > 0
      ? removedIds.map(id => {
          const item = oldById.get(id);
          const label = item && item.fileNumber ? `${item.fileNumber} (${id})` : id;
          return `removed ${label}`;
        }).join(', ')
      : '';
    const changes = [addedPart, removedPart].filter(Boolean).join('; ');
    lines.push(`**Items:** ${countPart}${changes ? ` (${changes})` : ''}\n`);
  }

  // 3. Genuinely new/removed documents — compare by title key, not by index
  const docKey = doc => (doc.title || doc.originalText || '').trim().toUpperCase();
  const newDocsByItem = [];
  const removedDocsByItem = [];

  for (const [id, newItem] of newById) {
    if (!oldById.has(id)) continue; // brand-new item — already reported above
    const oldItem = oldById.get(id);
    const oldDocs = oldItem.supportingDocuments || [];
    const oldDocKeys = new Set(oldDocs.map(docKey).filter(k => k));
    const newDocs = newItem.supportingDocuments || [];
    const newDocKeys = new Set(newDocs.map(docKey).filter(k => k));
    const genuinelyNew = newDocs.filter(doc => {
      const key = docKey(doc);
      return key && !oldDocKeys.has(key);
    });
    // Documents the clerk pulled (e.g. a presentation removed after the
    // meeting). These vanish from the regenerated post, so they must be
    // reported — a mirrored copy may still exist on R2.
    const removed = oldDocs.filter(doc => {
      const key = docKey(doc);
      return key && !newDocKeys.has(key);
    });
    newDocs.forEach(doc => {
      const key = docKey(doc);
      if (key && oldDocKeys.has(key)) urlOnlyCount++;
    });
    if (genuinelyNew.length > 0) {
      newDocsByItem.push({ id, item: newItem, docs: genuinelyNew });
    }
    if (removed.length > 0) {
      removedDocsByItem.push({ id, item: newItem, docs: removed });
    }
  }

  if (removedDocsByItem.length > 0) {
    hasMeaningfulChange = true;
    lines.push('**Removed documents:**');
    for (const { id, item, docs } of removedDocsByItem) {
      const label = item.fileNumber ? item.fileNumber : `agendaItemId=${id}`;
      lines.push(`  - ${label} (agendaItemId=${id}): ${docs.length} document${docs.length !== 1 ? 's' : ''} removed`);
      for (const doc of docs) {
        lines.push(`    - ${docKey(doc)}${doc.mirroredUrl ? ` (mirrored copy: ${doc.mirroredUrl})` : ''}`);
      }
    }
    lines.push('');
  }

  if (newDocsByItem.length > 0) {
    hasMeaningfulChange = true;
    lines.push('**New documents:**');
    for (const { id, item, docs } of newDocsByItem) {
      const label = item.fileNumber ? item.fileNumber : `agendaItemId=${id}`;
      lines.push(`  - ${label} (agendaItemId=${id}): ${docs.length} new document${docs.length !== 1 ? 's' : ''}`);
      for (const doc of docs) {
        lines.push(`    - ${docKey(doc)}`);
      }
    }
    lines.push('');
  }

  if (urlOnlyCount > 0) {
    lines.push(`_Note: ${urlOnlyCount} document URLs changed (publishId rotation only — suppressed)_\n`);
  }

  if (!hasMeaningfulChange) {
    return '✅ No meaningful changes (URL-only changes ignored)';
  }

  return lines.join('\n');
}

// Main
const args = process.argv.slice(2);

// Check for flags (preserve '-' as stdin indicator)
const summaryMode = args.includes('--summary') || args.includes('-s');
const filteredArgs = args.filter(arg => arg === '-' || !arg.startsWith('-'));

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
  
  if (summaryMode) {
    console.log(formatSummary(oldData, newData));
  } else {
    const diffs = deepEqual(oldData, newData);
    if (diffs.length === 0) {
      console.log('✅ No meaningful changes (URL-only changes ignored)');
    } else {
      console.log(`\n🔍 Found ${diffs.length} meaningful changes:\n`);
      console.log(formatDiff(diffs));
    }
  }
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

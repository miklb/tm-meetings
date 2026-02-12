/**
 * Helper functions for formatting WordPress output
 */

/**
 * Convert text to title case, preserving acronyms and file extensions
 * @param {string} text - The text to convert
 * @returns {string} - Title case text
 */
function toTitleCase(text) {
    // Handle file extensions and preserve them
    const fileExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt'];
    let preservedExtension = '';
    
    // Check if text ends with a file extension
    for (const ext of fileExtensions) {
        if (text.toLowerCase().endsWith(ext)) {
            preservedExtension = text.slice(-ext.length);
            text = text.slice(0, -ext.length);
            break;
        }
    }
    
    // Words that should remain lowercase (articles, prepositions, conjunctions)
    const lowercaseWords = [
        'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'nor', 
        'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with', 'from'
    ];
    
    // Words/patterns that should remain uppercase (common acronyms)
    const uppercasePatterns = [
        /^(TPD|FSA|HPC|DOT|FDOT|DLE|FBI|DEA|ATF|HIDTA|PDF|DOC|DOCX|XLS|XLSX|TFR|RESO)$/i,
        /^\d{2,4}$/  // Years like 2025, numbers
    ];
    
    // Split text into words while preserving separators
    const parts = text.split(/(\s+|-+|_+)/);
    
    return parts.map((part, index) => {
        // Keep separators as-is
        if (/^\s+$|^-+$|^_+$/.test(part)) {
            return part;
        }
        
        // Skip empty parts
        if (!part) return part;
        
        // Check if word should remain uppercase
        for (const pattern of uppercasePatterns) {
            if (pattern.test(part)) {
                return part.toUpperCase();
            }
        }
        
        // Count actual words (not separators) for title case logic
        const wordIndex = parts.slice(0, index).filter(p => !/^\s+$|^-+$|^_+$/.test(p) && p).length;
        
        // First word is always capitalized
        if (wordIndex === 0) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
        
        // Check if word should be lowercase
        if (lowercaseWords.includes(part.toLowerCase())) {
            return part.toLowerCase();
        }
        
        // Regular title case
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('') + preservedExtension;
}

module.exports = {
    toTitleCase
};

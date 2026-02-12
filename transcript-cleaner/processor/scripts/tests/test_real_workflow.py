#!/usr/bin/env python3
"""Test the REAL workflow: ALL CAPS → lowercase → NER → proper casing."""

import spacy

# Load the trained model
print("Loading model...")
nlp = spacy.load("data/models/tampa_ner/model/model-best")

# Real ALL CAPS transcript samples
all_caps_samples = [
    "THE TAMPA POLICE DEPARTMENT APPROVED FILE NUMBER 2024-123 FOR JOHN SMITH.",
    "MAYOR JANE CASTOR OPENED THE DISCUSSION ABOUT THE SUNSHINE LAW.",
    "THE CHIEF OF STAFF PRESENTED FILE NUMBER 2024-789 FOR TAMPA INTERNATIONAL AIRPORT.",
    "COUNCIL MEMBER LUIS VIERA DISCUSSED THE PUBLIC WORKS DEPARTMENT PROPOSAL.",
]

print("\n" + "="*70)
print("TESTING REAL WORKFLOW: ALL CAPS → LOWERCASE → NER → PROPER CASING")
print("="*70)

for i, all_caps_text in enumerate(all_caps_samples, 1):
    print(f"\n--- Sample {i} ---")
    print(f"Original (ALL CAPS):")
    print(f"  {all_caps_text}")
    
    # Step 1: Convert to lowercase (what the model was trained on)
    lowercase_text = all_caps_text.lower()
    print(f"\nStep 1 - Lowercase:")
    print(f"  {lowercase_text}")
    
    # Step 2: Apply NER model
    doc = nlp(lowercase_text)
    
    print(f"\nStep 2 - Entities Found:")
    if doc.ents:
        for ent in doc.ents:
            print(f"  • '{ent.text}' → {ent.label_}")
    else:
        print("  (none)")
    
    # Step 3: Demonstrate proper casing (simplified)
    result = lowercase_text.capitalize()
    for ent in doc.ents:
        # This is simplified - real version would need proper title casing logic
        if ent.label_ in ['PERSON', 'ORG', 'GPE', 'PRODUCT']:
            proper_case = ent.text.title()
            result = result.replace(ent.text, proper_case)
    
    print(f"\nStep 3 - Proper Casing Applied:")
    print(f"  {result}")

print("\n" + "="*70)
print("⚠️  KEY FINDING:")
print("="*70)
print("The model was trained on sentence-case agenda text, not lowercase.")
print("We need to RETRAIN with lowercase text to match transcript processing!")
print("="*70)

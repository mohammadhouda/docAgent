import { v4 as uuidv4 } from 'uuid';
import { openaiClient } from '../services/openai.js';
import { ExtractedValue, ValueType } from './types.js';

const MODEL = 'gpt-5.4-mini';
const CONCURRENCY = 5; // parallel page requests

// Prompt engineering is crucial here to get consistent, structured output from the LLM

const PROMPT = `You are a precise structured data extractor for construction project documents.

Extract ALL identifiable structured values from the page text below.
Return a JSON object with a single key "items" containing an array.

Each item must follow this exact shape:
{
  "type": "cost" | "date" | "percentage" | "duration" | "quantity" | "party" | "reference",
  "label": "descriptive name of what this value represents",
  "rawValue": "exact text as it appears in the document",
  "numericValue": <number or null>,
  "dateValue": "YYYY-MM-DD or null",
  "unit": "SAR / AED / USD / % / months / m² / etc. — or null",
  "context": "the full sentence or clause this value appears in (max 200 chars)"
}

TYPE GUIDE:
- cost: any monetary amount — numericValue is the full number (e.g. 1500000, not "1.5M")
- date: any calendar date, deadline, or milestone — dateValue in YYYY-MM-DD is required
- percentage: VAT, retention, margin, completion rate — numericValue is the whole number (15, not 0.15)
- duration: time period like "12 months", "365 days" — numericValue is the number, unit is time unit
- quantity: measured amount with unit like "500 m²" — numericValue is the number
- party: company name, contractor, client, consultant — no numericValue
- reference: contract number, drawing number, clause reference — no numericValue

RULES:
- Only extract values that are clearly present in the text — no inference or guessing
- Abbreviations like "1.5M SAR" must be expanded to 1500000
- Skip page numbers, headers, and formatting artifacts
- Return {"items": []} if nothing is found
- Output ONLY the JSON object, no prose`;

const VALID_TYPES = new Set<string>([
  'cost', 'date', 'percentage', 'duration', 'quantity', 'party', 'reference',
]);

interface RawItem {
  type?: string;
  label?: string;
  rawValue?: string;
  numericValue?: number | null;
  dateValue?: string | null;
  unit?: string | null;
  context?: string;
}

// Parses the LLM response and converts it into an array of ExtractedValue objects
function parseResponse(raw: string, documentId: string, pageNumber: number): ExtractedValue[] {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const items: RawItem[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.items) ? parsed.items : [];

    return items.flatMap((item): ExtractedValue[] => {
      if (!item.type || !VALID_TYPES.has(item.type)) return [];
      if (!item.label?.trim() || !item.rawValue?.trim()) return [];

      let dateValue: Date | undefined;
      if (item.dateValue) {
        const d = new Date(item.dateValue);
        if (!isNaN(d.getTime())) dateValue = d;
      }

      return [{
        id:           uuidv4(),
        documentId,
        type:         item.type as ValueType,
        label:        String(item.label).slice(0, 200),
        rawValue:     String(item.rawValue).slice(0, 200),
        numericValue: typeof item.numericValue === 'number' ? item.numericValue : undefined,
        dateValue,
        unit:         item.unit ? String(item.unit).slice(0, 20) : undefined,
        context:      String(item.context ?? item.rawValue).slice(0, 300),
        pageNumber,
      }];
    });
  } catch {
    return [];
  }
}

// Extract structured values from a single page's text
async function extractOnePage(
  pageText: string,
  pageNumber: number,
  documentId: string,
): Promise<ExtractedValue[]> {
  const text = pageText.trim();
  if (!text || text.length < 20) return [];

  try {
    const res = await openaiClient.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: `${PROMPT}\n\n--- PAGE ${pageNumber} ---\n${text}` }],
      temperature: 0,
    });
    return parseResponse(res.choices[0].message.content ?? '{}', documentId, pageNumber);
  } catch (err) {
    console.warn(`[PdfExtractor] Page ${pageNumber} failed: ${err}`);
    return [];
  }
}

// Main function to extract structured values from all page texts of a document
export async function extractFromPageTexts(
  pageTexts: string[],
  documentId: string,
): Promise<ExtractedValue[]> {
  const results: ExtractedValue[] = [];

  // Process CONCURRENCY pages at a time to avoid rate limits
  for (let i = 0; i < pageTexts.length; i += CONCURRENCY) {
    const batch = pageTexts.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((text, j) => extractOnePage(text, i + j + 1, documentId)),
    );
    results.push(...batchResults.flat());
  }

  return results;
}

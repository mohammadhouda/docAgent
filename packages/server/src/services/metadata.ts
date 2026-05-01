import { openaiClient } from './openai.js';
import { DocumentProfile } from '../types/index.js';

// Extracts initial document type and summary from first chunks.
// This is called BEFORE structured extraction, so we only have text content.
// After extraction completes, generateDocumentProfile() enriches this with
// stats from the extracted_values table (cost totals, sheet breakdown, value types).
export async function extractInitialProfile(
  firstChunksText: string,
  fileName: string,
): Promise<Partial<DocumentProfile>> {
  try {
    const excerpt = firstChunksText.slice(0, 4000);

    const response = await openaiClient.chat.completions.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You extract structured metadata from document excerpts. Return only valid JSON with no extra text.',
        },
        {
          role: 'user',
          content: `File name: "${fileName}"

Document excerpt:
${excerpt}

Return JSON with exactly these fields:
{
  "documentType": one of "contract" | "boq" | "specification" | "schedule" | "report" | "other",
  "projectName": string or null,
  "currency": dominant currency code (e.g. "SAR", "USD") or null,
  "parties": array of organisation/company names mentioned (max 4),
  "summary": one sentence describing what this document is,
  "language": ISO 639-1 code (e.g. "en", "ar", "fr")
}`,
        },
      ],
    });

    const raw = JSON.parse(response.choices[0].message.content ?? '{}');
    return {
      documentType: raw.documentType ?? 'other',
      projectName: raw.projectName ?? undefined,
      currency: raw.currency ?? 'SAR',
      parties: Array.isArray(raw.parties) ? raw.parties.slice(0, 4) : [],
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      language: typeof raw.language === 'string' ? raw.language : 'en',
    };
  } catch (err) {
    console.error('[profile] Failed to extract initial profile for', fileName, err instanceof Error ? err.message : err);
    return { documentType: 'other', language: 'en', currency: 'SAR' };
  }
}

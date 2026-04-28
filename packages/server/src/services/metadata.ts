import { openaiClient } from './openai.js';
import { DocumentMetadata } from '../types/index.js';

// This service is responsible for extracting structured metadata from document excerpts using the OpenAI API. It takes the text of the first few chunks of a document and its filename as input, and returns metadata such as document type, project name, dominant currency, involved parties, and a brief summary. The function handles potential errors gracefully by logging them and returning default metadata values when extraction fails.
export async function extractDocumentMetadata(
  firstChunksText: string,
  fileName: string,
): Promise<DocumentMetadata> {
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
  "type": one of "contract" | "boq" | "specification" | "schedule" | "report" | "other",
  "projectName": string or null,
  "currency": dominant currency code (e.g. "SAR", "USD") or null,
  "parties": array of organisation/company names mentioned (max 4),
  "summary": one sentence describing what this document is
}`,
        },
      ],
    });

    const raw = JSON.parse(response.choices[0].message.content ?? '{}');
    return {
      type: raw.type ?? 'other',
      projectName: raw.projectName ?? null,
      currency: raw.currency ?? null,
      parties: Array.isArray(raw.parties) ? raw.parties.slice(0, 4) : [],
      summary: typeof raw.summary === 'string' ? raw.summary : '',
    };
  } catch (err) {
    console.error('[metadata] Failed to extract metadata for', fileName, err instanceof Error ? err.message : err);
    return { type: 'other', parties: [] };
  }
}

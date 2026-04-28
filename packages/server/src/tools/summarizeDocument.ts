import { documentStore } from '../services/documentStore.js';
import { SourceReference, ToolResult } from '../types/index.js';

export async function summarizeDocument(args: { documentId: string }): Promise<ToolResult> {
  const doc = await documentStore.findDocument(args.documentId);

  if (!doc) {
    return { success: false, data: `Document "${args.documentId}" not found.`, sources: [] };
  }

  const total = doc.chunks.length;

  // Sample beginning, middle, and end so the LLM sees the full document structure,
  // not just the opening section.
  let selected = doc.chunks;
  if (total > 6) {
    const mid = Math.floor(total / 2);
    selected = [
      doc.chunks[0], doc.chunks[1],
      doc.chunks[mid], doc.chunks[mid + 1],
      doc.chunks[total - 2], doc.chunks[total - 1],
    ].filter(Boolean);
  }

  const content = selected
    .map((c) => `[${c.pageNumber ? `Page ${c.pageNumber}` : `Chunk ${c.chunkIndex + 1}`}]\n${c.content}`)
    .join('\n\n[...]\n\n');

  const sources: SourceReference[] = selected.map((c) => ({
    documentName: doc.fileName,
    location: c.pageNumber ? `Page ${c.pageNumber}` : `Chunk ${c.chunkIndex + 1}`,
    excerpt: c.content.slice(0, 150),
  }));

  return {
    success: true,
    data: `DOCUMENT: ${doc.fileName} (${total} chunks total — beginning, middle, and end sampled)\n\n${content}`,
    sources,
  };
}

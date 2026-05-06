import { documentStore } from '../services/documentStore.js';
import { generateEmbedding } from '../services/embeddings.js';
import { Document, DocumentChunk, SourceReference, ToolResult } from '../types/index.js';

// This tool performs a search across all loaded documents using either semantic similarity (if embeddings are available) or keyword matching as a fallback.
// It accepts a query string and an optional maximum number of results to return. The output includes the matched content along with source citations for transparency.

export async function searchDocuments(args: {
  query: string;
  maxResults?: number;
}): Promise<ToolResult> {
  const { query, maxResults = 8 } = args;

  if (await documentStore.count() === 0) {
    return { success: false, data: 'No documents loaded.', sources: [] };
  }

  // Prefer semantic search when embeddings are available
  let matches: Array<{ chunk: DocumentChunk; document: Document }>;
  let searchMode: string;

  if (await documentStore.hasEmbeddings()) {
    const queryEmbedding = await generateEmbedding(query);
    matches = await documentStore.searchBySimilarity(queryEmbedding, maxResults);
    searchMode = 'semantic';
  } else {
    matches = await documentStore.searchByKeyword(query, maxResults);
    searchMode = 'keyword';
  }

  if (matches.length === 0) {
    return {
      success: true,
      data: `No results found for: "${query}" (${searchMode} search). Try broader keywords.`,
      sources: [],
    };
  }

  const resultText = matches
    .map(({ chunk, document }, i) => {
      const location = chunk.pageNumber
        ? `Page ${chunk.pageNumber}`
        : chunk.sheetName
          ? `Sheet: ${chunk.sheetName}`
          : `Chunk ${chunk.chunkIndex + 1}`;

      // Include the next two chunks so that body-text sections that follow header/table
      // chunks are always visible — prevents the agent missing content that ranked just
      // outside the top-N but is physically adjacent to the matched chunk.
      let content = chunk.content;
      const next1 = document.chunks[chunk.chunkIndex + 1];
      const next2 = document.chunks[chunk.chunkIndex + 2];
      if (next1) content += `\n[CONTINUES →]:\n${next1.content}`;
      if (next2) content += `\n[...]\n${next2.content.slice(0, 400)}`;

      return `[Result ${i + 1}] FILE: ${document.fileName} (${location})\n${content}`;
    })
    .join('\n\n---\n\n');

  const sources: SourceReference[] = matches.map(({ chunk, document }) => ({
    documentName: document.fileName,
    location: chunk.pageNumber ? `Page ${chunk.pageNumber}` : `Sheet: ${chunk.sheetName}`,
    excerpt: chunk.content.slice(0, 200),
  }));

  return {
    success: true,
    data: `Search results for "${query}" (${searchMode}):\n\n${resultText}`,
    sources,
  };
}

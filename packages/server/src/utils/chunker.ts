import { ChunkType, DocumentChunk } from '../types/index.js';
import { config } from '../config.js';

export type { ChunkType };

export interface TextBlock {
  text:          string;
  type:          ChunkType;
  sectionTitle?: string;
  pageNumber?:   number;
}

// 1 token ≈ 4 chars — accurate enough for English + construction numbers/codes.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TARGET: Record<ChunkType, number> = {
  text:    config.targetTokensText,
  table:   config.targetTokensTable,
  heading: config.targetTokensText,  // headings flow into following text blocks
};

// Produce a smart overlap string from the blocks just flushed.
function buildOverlap(blocks: TextBlock[], type: ChunkType): string {
  const full = blocks.map((b) => b.text).join('\n');
  if (type === 'table') {
    // Carry the last 2 data rows so the next chunk has column context.
    const rows = full.split('\n').filter(Boolean);
    return rows.slice(-2).join('\n');
  }
  // Carry the last paragraph, or last sentence if no paragraph break.
  const paraBreak = full.lastIndexOf('\n\n');
  const candidate = paraBreak > 0
    ? full.slice(paraBreak).trim()
    : (() => {
        const sent = full.lastIndexOf('. ');
        return sent > 0 ? full.slice(sent + 1).trim() : '';
      })();
  const maxChars = config.overlapTokens * 4;
  return candidate.length > maxChars ? candidate.slice(-maxChars) : candidate;
}

// Split a single block that is too large to fit the token budget, at paragraph
// then sentence boundaries.
function splitLarge(block: TextBlock, maxTokens: number): TextBlock[] {
  if (estimateTokens(block.text) <= maxTokens * 1.5) return [block];

  const parts: string[] = [];
  let current = '';

  for (const para of block.text.split(/\n{2,}/)) {
    if (estimateTokens(current + '\n\n' + para) > maxTokens && current) {
      parts.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return (parts.length > 1 ? parts : [block.text]).map((t) => ({ ...block, text: t }));
}

/**
 * Converts a sequence of typed text blocks into DocumentChunks.
 *
 * Rules:
 *  - Blocks are grouped until the token budget for their type is reached.
 *  - A type change (text → table or vice-versa) forces a flush so chunks stay homogeneous.
 *  - Single blocks that are too large are split at paragraph / sentence boundaries first.
 *  - Chunks below minChunkTokens are merged into the previous chunk.
 *  - Smart overlap is appended as a prefix to the next chunk (last paragraph for text,
 *    last 2 rows for table).
 *  - chunkIndex values are local (0-based); callers re-index across multiple calls.
 */
export function chunkBlocks(
  blocks:      TextBlock[],
  documentId:  string,
  sheetName?:  string,
): DocumentChunk[] {
  if (blocks.length === 0) return [];

  const results: DocumentChunk[] = [];
  let localIndex = 0;

  let group:       TextBlock[]  = [];
  let groupTokens  = 0;
  let groupType:   ChunkType    = blocks[0].type;
  let overlapText  = '';

  function flush() {
    if (group.length === 0) return;

    const raw     = group.map((b) => b.text).join('\n').trim();
    const content = overlapText ? `${overlapText}\n${raw}` : raw;

    // Merge tiny chunks into the previous one instead of creating noise.
    if (estimateTokens(content) < config.minChunkTokens && results.length > 0) {
      results[results.length - 1].content += `\n${content}`;
      group       = [];
      groupTokens = 0;
      return;
    }

    const first = group[0];
    results.push({
      id:           `${documentId}-chunk-${localIndex}`,
      documentId,
      content,
      chunkIndex:   localIndex++,
      chunkType:    groupType,
      sectionTitle: first.sectionTitle || undefined,
      pageNumber:   first.pageNumber,
      sheetName,
    });

    overlapText = buildOverlap(group, groupType);
    group       = [];
    groupTokens = 0;
  }

  for (const block of blocks) {
    const subBlocks = splitLarge(block, TARGET[block.type]);

    for (const sub of subBlocks) {
      const subTokens   = estimateTokens(sub.text);
      const willExceed  = groupTokens + subTokens > TARGET[sub.type];
      const typeChanged = group.length > 0 && sub.type !== groupType && sub.type !== 'heading';

      if ((willExceed || typeChanged) && group.length > 0) {
        flush();
        groupType = sub.type;
      }

      // Headings don't override the current group type — they flow into the next text block.
      if (sub.type !== 'heading') groupType = sub.type;

      group.push(sub);
      groupTokens += subTokens;
    }
  }

  flush();
  return results;
}

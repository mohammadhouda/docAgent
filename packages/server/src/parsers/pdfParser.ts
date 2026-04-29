import pdfParse from 'pdf-parse';
import fs from 'fs';
import { DocumentChunk } from '../types/index.js';
import { chunkBlocks, TextBlock } from '../utils/chunker.js';
import { config } from '../config.js';
import { extractFromPageTexts } from '../extractors/pdfExtractor.js';
import { ExtractedValue } from '../extractors/types.js';

// ─── Line reconstruction from PDF text items ─────────────────────────────────

interface PdfLine {
  text:      string;
  y:         number;
  maxHeight: number;
}

/**
 * Groups raw PDF text items into visual lines using Y-coordinate proximity.
 * Items within 3 units of Y are treated as the same line and ordered left→right by X.
 * This preserves table cell alignment that join(' ') destroys.
 */
function reconstructLines(items: any[]): PdfLine[] {
  const filtered = items
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item) => ({
      str:    item.str as string,
      x:      (item.transform?.[4] as number) ?? 0,
      y:      (item.transform?.[5] as number) ?? 0,
      height: (item.height as number)         || 0,
    }))
    // PDF Y-axis is bottom-up: larger Y = higher on page → sort descending
    .sort((a, b) => {
      const dy = b.y - a.y;
      return Math.abs(dy) > 3 ? dy : a.x - b.x;
    });

  if (filtered.length === 0) return [];

  const lines: PdfLine[] = [];
  let lineItems = [filtered[0]];
  let lineY     = filtered[0].y;

  for (let i = 1; i < filtered.length; i++) {
    const item = filtered[i];
    if (Math.abs(item.y - lineY) > 3) {
      lines.push({
        text:      lineItems.map((li) => li.str).join(' ').trim(),
        y:         lineY,
        maxHeight: Math.max(...lineItems.map((li) => li.height)),
      });
      lineItems = [item];
      lineY     = item.y;
    } else {
      lineItems.push(item);
    }
  }
  lines.push({
    text:      lineItems.map((li) => li.str).join(' ').trim(),
    y:         lineY,
    maxHeight: Math.max(...lineItems.map((li) => li.height)),
  });

  return lines.filter((l) => l.text.length > 0);
}

// ─── Block detection ──────────────────────────────────────────────────────────

// Matches numbered headings, Article/Section/Clause/Schedule markers.
const HEADING_RE = /^(\d+(\.\d+)*\.?\s|Article\s|ARTICLE\s|Section\s|SECTION\s|Clause\s|CLAUSE\s|Schedule\s|SCHEDULE\s|Annex\s|ANNEX\s|PART\s+[IVX\d])/i;
const NUMBER_RE  = /\b\d[\d,.]*\b/g;

/**
 * Converts a page's lines into typed TextBlocks.
 *
 * Heading detection (both conditions required):
 *   - Short line (< 120 chars, ≤ 3 visual lines in the paragraph)
 *   - Large font (> 115% of page average) OR matches HEADING_RE
 *
 * Table detection: paragraph contains more number tokens than word tokens.
 *
 * Lines are grouped into paragraphs at Y gaps > 1.6× average line height.
 * Section title propagates forward until a new heading resets it.
 */
function detectBlocks(lines: PdfLine[], pageNumber: number): TextBlock[] {
  if (lines.length === 0) return [];

  const heights = lines.map((l) => l.maxHeight).filter((h) => h > 0);
  const avgH    = heights.length > 0
    ? heights.reduce((s, h) => s + h, 0) / heights.length
    : 10;

  // Group lines into visual paragraphs by Y gap
  const paragraphs: PdfLine[][] = [];
  let currentPara: PdfLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i - 1].y - lines[i].y);
    if (gap > avgH * 1.6) {
      paragraphs.push(currentPara);
      currentPara = [lines[i]];
    } else {
      currentPara.push(lines[i]);
    }
  }
  if (currentPara.length > 0) paragraphs.push(currentPara);

  const blocks: TextBlock[] = [];
  let currentSection = '';

  for (const para of paragraphs) {
    const text = para.map((l) => l.text).join('\n').trim();
    if (!text) continue;

    const maxH        = Math.max(...para.map((l) => l.maxHeight));
    const isLargeFont = heights.length > 3 && maxH > avgH * 1.15;
    const isShort     = text.length < 120 && para.length <= 3;
    const isHeading   = isShort && (isLargeFont || HEADING_RE.test(text));

    if (isHeading) {
      currentSection = text.split('\n')[0].trim();
      blocks.push({ text, type: 'heading', sectionTitle: currentSection, pageNumber });
      continue;
    }

    const numbers = (text.match(NUMBER_RE) ?? []).length;
    const words   = (text.match(/\b[a-zA-Z]{3,}\b/g) ?? []).length;
    const type    = numbers >= 3 && numbers >= words ? 'table' : 'text';

    blocks.push({ text, type, sectionTitle: currentSection, pageNumber });
  }

  return blocks;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export interface PdfParseResult {
  chunks:          DocumentChunk[];
  totalPages:      number;
  warnings:        string[];
  extractedValues: ExtractedValue[];
}

export async function parsePdf(filePath: string, documentId: string): Promise<PdfParseResult> {
  const warnings: string[] = [];
  const buffer = fs.readFileSync(filePath);

  // pageTexts: newline-joined text per page (for LLM extraction — better than space-joined)
  // pageBlocks: typed blocks per page (for smart chunking)
  const pageTexts:  string[]      = [];
  const pageBlocks: TextBlock[][] = [];

  const parseResult = await pdfParse(buffer, {
    max: config.maxPdfPages,
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent();
      const pageNum     = pageTexts.length + 1;
      const lines       = reconstructLines(textContent.items);
      const text        = lines.map((l) => l.text).join('\n');
      pageTexts.push(text.trim());
      pageBlocks.push(detectBlocks(lines, pageNum));
      return text;
    },
  });

  const totalPages = parseResult.numpages;

  if (totalPages > config.maxPdfPages) {
    warnings.push(`PDF has ${totalPages} pages; only first ${config.maxPdfPages} pages processed.`);
  }

  if (pageTexts.length === 0) {
    warnings.push('PDF appears to be empty or has no extractable text (possibly image-based).');
    return { chunks: [], totalPages, warnings, extractedValues: [] };
  }

  // Flatten all page blocks into one stream so headings propagate across page breaks
  // and chunkBlocks can group across page boundaries naturally.
  const allBlocks: TextBlock[] = [];
  let currentSection = '';

  for (let i = 0; i < pageBlocks.length; i++) {
    for (const block of pageBlocks[i]) {
      if (block.type === 'heading') currentSection = block.text.split('\n')[0].trim();
      allBlocks.push({
        ...block,
        sectionTitle: block.sectionTitle || currentSection,
      });
    }
  }

  const chunks = chunkBlocks(allBlocks, documentId);

  // Assign final deterministic IDs
  chunks.forEach((c, idx) => { c.chunkIndex = idx; c.id = `${documentId}-chunk-${idx}`; });

  const extractedValues = await extractFromPageTexts(pageTexts, documentId);

  return { chunks, totalPages, warnings, extractedValues };
}

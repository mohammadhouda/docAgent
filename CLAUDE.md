# DocAgent — Claude Code Context

## Project Overview

AI-powered document Q&A for construction and engineering projects. Upload BOQs, contracts, specs, and schedules — ask natural language questions, get structured cited answers.

---

## Project Layout

npm workspace monorepo. Two packages:

| Package | Port | Purpose |
|---|---|---|
| `packages/server` | 3001 | Express + TypeScript API |
| `packages/web` | 3000 | Next.js 14 + Tailwind frontend |

**Run both:** `npm run dev` from project root.

**TypeScript check:**
```bash
npx tsc -p packages/server/tsconfig.json --noEmit
npm run build --workspace=packages/web
```

---

## Stack

| Component | Technology |
|---|---|
| **Database** | PostgreSQL 14+ with `pgvector` (HNSW index), Drizzle ORM |
| **Queue** | BullMQ + Redis |
| **AI Models** | OpenAI `gpt-5.4-mini` (extraction), `gpt-4o-mini` (agent), `text-embedding-3-small` (embeddings) |
| **Parsing** | `pdf-parse` (coordinate-based), `exceljs` (section-aware) |

---

## Key Files

| File | Purpose |
|---|---|
| `packages/server/src/services/agent.ts` | GPT function-calling agent loop |
| `packages/server/src/services/openai.ts` | SYSTEM_PROMPT with tool routing rules |
| `packages/server/src/tools/index.ts` | All 16 tool definitions + `executeTool` dispatcher |
| `packages/server/src/tools/` | One file per tool implementation |
| `packages/server/src/tools/aggregateValues.ts` | Budget/actual/cost aggregation with type aliases |
| `packages/server/src/tools/queryValues.ts` | Filtered value retrieval |
| `packages/server/src/services/queue.ts` | BullMQ workers for uploads + ask jobs |
| `packages/server/src/routes/ask.ts` | POST enqueues job (202), GET /jobs/:id polls |
| `packages/server/src/routes/upload.ts` | Multipart upload, job creation |
| `packages/server/src/db/schema.ts` | Drizzle table definitions |
| `packages/server/src/extractors/excelExtractor.ts` | LLM schema inference + type normalization |
| `packages/server/src/extractors/pdfExtractor.ts` | Per-page LLM extraction |
| `packages/web/src/components/StructuredAnswer.tsx` | JSON answer renderer |
| `packages/web/src/app/page.tsx` | Main chat interface |
| `packages/server/test-docs/` | Sample BOQs, schedules, vendor registers |

---

## Database Tables

| Table | Purpose |
|---|---|
| `documents` | File metadata, classification (type, currency, parties, summary) |
| `chunks` | Text segments + `vector(1536)` embeddings (HNSW index) |
| `extracted_values` | Structured extractions (costs, dates, quantities, parties, percentages, outstanding, contract values) |
| `conversations` | Chat sessions |
| `messages` | User/assistant message history |

**Cascade deletes:** `chunks` and `extracted_values` have `ON DELETE CASCADE` on `documents.id`.

---

## Extracted Value Types

The Excel extractor normalizes monetary columns based on header keywords:

| Header Contains | Type Assigned |
|---|---|
| "budget", "planned" | `budget` |
| "actual", "paid", "spent", "to date" | `actual` |
| "outstanding", "balance", "payable" | `outstanding` |
| "variance", "difference" | `variance` |
| "contract" | `contract_value` |
| "committed" | `committed_cost` |
| Other monetary | `cost` |

**Type aliases in `aggregateValues`:**
```typescript
'budget': ['budget', 'budgeted_cost', 'contract_value'],
'actual': ['actual', 'actual_cost'],
'committed': ['committed', 'committed_cost'],
'variance': ['variance', 'variance_cost'],
'outstanding': ['outstanding'],
```

---

## Tools (16 Total)

| Tool | File | Purpose |
|---|---|---|
| `list_documents` | `getDocumentInfo.ts` | List all loaded documents |
| `get_document_sections` | `getDocumentInfo.ts` | Show sheet/section breakdown |
| `search_documents` | `searchDocuments.ts` | Semantic search via pgvector |
| `query_values` | `queryValues.ts` | Filtered value retrieval |
| `aggregate_values` | `aggregateValues.ts` | Sum/avg/count with groupBy |
| `compute_result` | `computeResult.ts` | Arithmetic (sum, difference, ratio, apply_rate) |
| `calculate_cost_summary` | — | Legacy, use `aggregate_values` |
| `compare_costs` | — | Legacy, use `aggregate_values` |
| `calculate_cost_variance` | — | Legacy, use `compute_result` |
| `calculate_percentage_of_total` | — | Legacy, use `compute_result` |
| `calculate_unit_rate` | — | Legacy, use `compute_result` |
| `extract_cost_items` | `queryValues.ts` | List cost line items |
| `extract_dates_deliverables` | `queryValues.ts` | List dates |
| `extract_quantities` | `queryValues.ts` | List quantities |
| `extract_parties` | `queryValues.ts` | List parties |
| `extract_percentages` | `queryValues.ts` | List percentages |
| `summarize_document` | `getDocumentInfo.ts` | AI summary |

---

## Adding a New Tool — Checklist

1. Create `packages/server/src/tools/myTool.ts` (export `async function`)
2. Import + add tool definition in `packages/server/src/tools/index.ts`
3. Add case in `executeTool` switch
4. Add routing rule in SYSTEM_PROMPT (`packages/server/src/services/openai.ts`)
5. Test with sample query

**Tool signature:**
```typescript
export async function myTool(args: {
  documentId?: string;
  category?: string;
  // ... other args
}): Promise<ToolResult> {
  // Query PostgreSQL
  // Return { success: true, data: {...}, sources: [...] }
}
```

---

## Adding a New Answer Section Type — Checklist

1. Add interface to `packages/server/src/types/index.ts`
2. Add to `AnswerSection` union type
3. Mirror type in `packages/web/src/lib/api.ts`
4. Add renderer in `packages/web/src/components/StructuredAnswer.tsx`
5. Document in SYSTEM_PROMPT output format section

**Section types:**
- `paragraph` — plain text
- `key_facts` — label/value grid
- `table` — headers + rows
- `timeline` — date-ordered items
- `list` — bulleted items
- `parties` — role + company cards

---

## Category Resolution (Semantic Matching)

Tools with `category` parameter resolve it semantically:

1. Embed term using `text-embedding-3-small`
2. Find nearest sheet/section names (cosine distance < 0.65)
3. Build `ILIKE ANY(patterns)` SQL filter

**Example:**
- Input: `"electrical"`
- Patterns: `['%electrical%', '%Electrical Works%', '%ELC%']`
- SQL: `WHERE section_title ILIKE ANY($patterns)`

See: `packages/server/src/tools/utils.ts` → `resolveCategory()`, `categoryMatchSQL()`

---

## Excel Extraction Flow

1. **Header Detection:** First row with ≥2 distinct non-empty cells
2. **LLM Schema Inference:** `gpt-5.4-mini` classifies columns (label, item_no, value, category)
3. **Type Normalization:** Header keywords override LLM inference
4. **Row Processing:** Extract values for each `value` column
5. **Section Title:** Use category column value if available

**Key function:** `extractFromWorkbook()` in `packages/server/src/extractors/excelExtractor.ts`

---

## Agent Loop

1. System prompt includes loaded document inventory
2. Model chooses tool based on question
3. Tool executes SQL
4. Result returned to model
5. Repeat (max 5 iterations)
6. Model synthesizes structured JSON answer

**Key constraint:** Agent never does arithmetic — always calls tools.

---

## Coding Standards

| Rule | Example |
|---|---|
| No comments unless WHY is non-obvious | Explain trade-offs, not what code does |
| No dead code, no unused exports | Remove unused imports, functions |
| TypeScript strict | No `any`, proper types |
| AI never does arithmetic | Always call `compute_result` or tools |
| AI returns structured JSON | Never markdown in final answer |
| Type normalization in extractor | Header keywords override LLM |

---

## Common Tasks

### Re-ingest a document

```typescript
// Delete existing
await pool.query(`DELETE FROM extracted_values WHERE document_id = $1`, [docId]);
await pool.query(`DELETE FROM documents WHERE id = $1`, [docId]);

// Re-run ingestFile()
```

### Query extracted values

```sql
SELECT type, section_title, SUM(numeric_value) as total
FROM extracted_values
WHERE document_id = $1 AND type IN ('budget', 'actual')
GROUP BY section_title;
```

### Test tool directly

```bash
cd packages/server
node -e "const { aggregateValues } = require('./dist/tools/aggregateValues.js'); aggregateValues({ type: 'outstanding', groupBy: 'section' }).then(console.log);"
```

---

## Debugging Tips

### Type not matching

Check type normalization in `excelExtractor.ts`:
```typescript
if (h.includes('outstanding')) return 'outstanding';
```

### Category not resolving

Check `resolveCategory()` in `tools/utils.ts` — verify embeddings are generated.

### Tool not being called

Check SYSTEM_PROMPT routing rules in `services/openai.ts`.

### Section title null

Verify Excel has a "Category" column and LLM classified it as `role: 'category'`.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `DATABASE_URL` | PostgreSQL with pgvector |
| `REDIS_URL` | BullMQ queue |
| `PORT` | Backend port (default 3001) |
| `CORS_ORIGIN` | Frontend origin (default http://localhost:3000) |

---

## Quick Reference

**Run dev:** `npm run dev`

**Build:** `npm run build`

**Check types:** `npx tsc -p packages/server/tsconfig.json --noEmit`

**Re-ingest test docs:**
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{ "folderPath": "c:/assesment/doc-agent/packages/server/test-docs" }'
```

**Query database:**
```bash
cd packages/server
node -e "const { pool } = require('./dist/db/client.js'); pool.query('SELECT COUNT(*) FROM documents').then(console.log);"
```

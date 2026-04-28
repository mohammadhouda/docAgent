# DocAgent — Build Notes

## AI Coding Agent Used

**Claude Code** (Anthropic) — used throughout the entire build for architecture, code generation, refactoring, and documentation.

---

## Build Phases

### Phase 1 — Project Setup
Monorepo scaffold with npm workspaces, shared `tsconfig.base.json`, `concurrently` dev runner, `.env` wiring.

### Phase 2 — Parsing & Ingestion
- PDF: per-page text extraction via `pdf-parse` with `pagerender` callback; chunks tagged with page number
- Excel: row-batch chunking via `exceljs`; column headers prepended to each row for context
- Chunker: ~6 000-char chunks with 200-char overlap, breaks at paragraph then sentence boundaries
- Multer upload route + folder-path ingest route; both call the same `ingestFile()` pipeline

### Phase 3 — AI Agent (initial)
- OpenAI function-calling loop (max 5 iterations) in `services/agent.ts`
- Initial 5 tools: `list_documents`, `search_documents`, `extract_cost_items`, `extract_dates_deliverables`, `summarize_document`
- GPT-driven metadata extraction on every ingested document (type, project name, currency, parties)

### Phase 4 — Frontend
- Next.js + Tailwind chat interface
- Drag-and-drop file upload with job progress display
- Collapsible source citations per message
- Tool-used badges on assistant messages

### Phase 5 — Semantic Search
- `text-embedding-3-small` embeddings generated at ingest time (batched 100/request)
- `searchBySimilarity()` using pgvector cosine distance (`<=>` operator) with HNSW index
- `searchDocuments` tool prefers semantic search; falls back to PostgreSQL FTS when no embeddings exist

### Phase 6 — Structured JSON Responses
Replaced free-form string responses with a typed JSON schema rendered as rich UI components.

**Why:** The AI was generating inconsistent markdown — sometimes tables, sometimes bullets, sometimes prose. The frontend had no way to distinguish a cost table from a milestone list.

**What changed:**
- `StructuredAnswer` type added to both backend and frontend
- System prompt rewritten: AI must return a raw JSON object; no markdown, no code fences
- `agent.ts` parses with `JSON.parse`, falls back to `{ type: "paragraph" }` on failure
- `StructuredAnswer.tsx` dispatches each section to a typed renderer (key_facts, timeline, table, list, parties, paragraph)
- `react-markdown` removed entirely from `MessageBubble`

### Phase 7 — PostgreSQL + Drizzle + BullMQ
Replaced the in-memory document store with a proper persistence layer.

**What was added:**
- PostgreSQL schema: `documents`, `chunks`, `conversations`, `messages`, `extracted_values`
- Drizzle ORM for type-safe queries; raw `pg` pool for vector and FTS operations
- pgvector extension — embeddings stored in `chunks.embedding vector(1536)` with HNSW index
- BullMQ async job queue for file uploads — server responds immediately, worker processes in background
- Conversation + message persistence — chat history survives page reload
- `db/migrate.ts` runs `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` on startup

### Phase 8 — Structured Value Extraction
Added a second extraction pass that stores individual typed values in `extracted_values` for direct SQL queries.

**Excel** — deterministic column classifier (`excelExtractor.ts`):
- Smart header row detection (skips merged title rows)
- Column type classification via regex (cost, date, quantity, party, percentage, reference, duration)
- Cost column priority: Committed > Total Amount > Amount > Qty × Rate fallback
- Summary sheets (no item-number column) excluded from line-item extraction
- Total/Grand Total rows skipped

**PDF** — per-page LLM extraction (`pdfExtractor.ts`):
- 5 concurrent `gpt-4o-mini` calls per batch of pages
- Returns typed items: `{ type, label, rawValue, numericValue, dateValue, unit, context }`

### Phase 9 — Tool Expansion (5 → 11 tools)
Added 6 new tools targeting the `extracted_values` table directly — zero AI tokens at query time:

| Tool | Purpose |
|---|---|
| `calculate_cost_summary` | Grouped cost totals by sheet or trade; accepts `category` filter |
| `compare_costs` | Cross-document cost comparison with optional category/document filters |
| `extract_quantities` | Measured quantities filterable by unit and minimum value |
| `extract_parties` | Named parties deduplicated by role + name |
| `extract_percentages` | VAT, retention, markup rates sorted by value |
| `get_document_sections` | Sheet names with cost totals + item-code prefix breakdown (A, B, M, E…) |

**`extract_cost_items` enhanced:** added `category` filter (ILIKE against label and sheet name) and `maxAmount` upper bound.

**`calculate_cost_summary` category filter:** dual ILIKE matches both `sheet_name` and `ev.label` — handles both sheet-per-trade layouts and single-sheet BOQs where trade appears only in item descriptions.

System prompt updated with precise tool routing rules, parallel tool call guidance, and `list_documents` frequency fix (once per session, not every message).

### Phase 10 — Refactor Pass
Senior-engineer clean-up of the full codebase.

| File | Change |
|---|---|
| `services/agent.ts` | Fixed `gpt-5.4-mini` → `gpt-4o-mini`; moved imports to top; renamed param `conversationId` → `requestId`; removed `stringifyContent` helper; extracted `FALLBACK_ANSWER` constant; removed `|| 5` redundant fallback |
| `services/metadata.ts` | Fixed `gpt-5.4-mini` → `gpt-4o-mini` |
| `services/embeddings.ts` | Removed `cosineSimilarity` — exported but never used |
| `services/requestStatus.ts` | Renamed all params from `conversationId` → `requestId`; modernised interval |
| `types/index.ts` | Removed `AskRequest` interface — never used |
| `index.ts` | Removed `export default app` — never imported; CORS origin reads from `config.corsOrigin` |
| `config.ts` | Added `corsOrigin` field (reads `CORS_ORIGIN` env var) |
| `tools/getDocumentSections.ts` | Added `d.file_name` to prefix query; fixed fallback logic that was returning UUID instead of filename |
| `components/ChatInterface.tsx` | Removed broken status polling — it ran after `askQuestion` resolved, so the status was already deleted; UI never updated |

### Phase 11 — Async Ask Queue

Converted `POST /api/ask` from a blocking request to an async BullMQ job to eliminate socket hangouts on long-running agent loops (up to 90 s).

**Why:** Long AI requests hit proxy/browser socket timeouts. The same pattern already worked for file uploads.

**What changed:**

| File | Change |
|---|---|
| `services/queue.ts` | Added `AskJobData` type, `askQueue`, and `createAskWorker()` — worker runs `runAgent()` + saves assistant message; concurrency 3 |
| `routes/ask.ts` | Rewrote: POST enqueues job → 202 `{ jobId }`; removed blocking `runAgent` call; added `GET /jobs/:jobId` for polling |
| `index.ts` | Added `createAskWorker()` call on startup |
| `lib/api.ts` | `askQuestion` now POSTs to enqueue then polls `GET /ask/jobs/:jobId` every 1 s until `completed`/`failed`; removed unused `getAskStatus`; added optional `onStatus` callback |
| `components/ChatInterface.tsx` | Passes `onStatus` callback → loading indicator shows real-time tool-call status |

The in-process `requestStatus` map still works — worker runs in the same Node.js process so granular status ("Calling calculate cost summary…") flows through to the polling endpoint unchanged.

---

## Key Design Decisions

**Function calling over prompt stuffing** — the agent uses GPT tool calls to run targeted SQL queries instead of dumping all document text into the prompt. Keeps each LLM call focused, reduces token cost, produces grounded answers.

**Structured JSON responses** — the AI returns a typed schema, not markdown. The frontend owns all presentation. The same data can be rendered differently in different contexts without touching the backend.

**AI/frontend separation** — AI never attempts to format output (no markdown tables, no bullet dashes). The frontend components own all visual decisions.

**Deterministic Excel extraction** — column classification and value extraction are regex-based, not LLM-based. Zero tokens consumed per row. LLM extraction is reserved for PDFs where structure is unpredictable.

**Dual-mode search** — pgvector cosine similarity at query time; PostgreSQL full-text search as fallback. Both return the same shape so the rest of the stack is unaffected.

**Shared ingestion pipeline** — `ingestFile()` in `services/ingestion.ts` is the single implementation of parse → embed → classify → extract → store. Both the folder-ingest and file-upload routes call it identically.

**Async upload queue** — BullMQ with concurrency 1 prevents hammering OpenAI rate limits while allowing the UI to show per-file progress. Files are cleaned from temp storage in the worker's `finally` block.

**Cascade deletes** — `chunks` and `extracted_values` reference `documents` with `ON DELETE CASCADE`. A single `DELETE FROM documents WHERE id = $1` cleans up everything.

---

## Known Limitations

1. **OCR** — `pdf-parse` can't extract text from image-based or scanned PDFs
2. **Streaming** — answers are buffered then sent; no token-by-token streaming to the UI
3. **Authentication** — no auth; all documents, conversations, and answers are globally accessible
4. **Multi-user isolation** — one shared document store per server instance; all sessions see the same documents
5. **Excel merged cells** — merged cells in data rows can confuse column counting; header merged cells are handled by the header-row detection logic

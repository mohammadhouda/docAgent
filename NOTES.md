# DocAgent — Build Notes

## AI Coding Agent

Built with **Claude Code** (Qwen Code) assisting across architecture, code generation, refactoring, debugging, and documentation throughout all development phases.

---

## Development Time

Approximately **15–18 hours** across multiple iterative development phases.

The project was built using an AI-assisted workflow with Claude Code as a development accelerator. Engineering direction, architecture decisions, feature priorities, validation, and refinements were led throughout the process.

Each phase started from a product or technical objective. Claude Code helped implement changes across multiple files, while outputs were reviewed, tested, issues identified, requirements adjusted, and next iterations guided.

The workflow combined engineering judgment with AI-assisted execution to move faster while maintaining control over system design and quality.

---

## Build Phases

| Phase | What Was Built |
|---|---|
| 1 | **Monorepo scaffold** — npm workspaces, shared tsconfig, concurrently dev runner |
| 2 | **Parse & ingest** — PDF per-page + Excel row-batch, chunker with overlap, Multer upload route |
| 3 | **AI agent** — GPT function-calling loop, 5 initial tools, document metadata extraction |
| 4 | **Frontend** — Next.js chat interface, drag-and-drop upload, source citations, tool badges |
| 5 | **Semantic search** — `text-embedding-3-small` embeddings, pgvector cosine similarity, FTS fallback |
| 6 | **Structured JSON responses** — typed section schema, system prompt rewrite, `StructuredAnswer.tsx` renderer |
| 7 | **PostgreSQL persistence** — Drizzle ORM, pgvector, BullMQ upload queue, conversation history |
| 8 | **Structured value extraction** — deterministic Excel column classifier, per-page LLM extraction for PDFs |
| 9 | **Tool expansion (5 → 16)** — cost summary, compare costs, quantities, parties, percentages, sections; `category` filter added |
| 10 | **Refactor pass** — dead code removed, misleading names fixed, model name bug corrected, broken polling removed |
| 11 | **Async ask queue** — `POST /api/ask` converted to BullMQ job, eliminates socket hangouts |
| 12 | **Budget vs Actual tracking** — type normalization for budget/actual/variance columns, over-budget detection |
| 13 | **Vendor outstanding tracking** — outstanding type, contract_value type, type aliases in aggregateValues |
| 14 | **Category aggregation fix** — LLM prompt for category columns, section_title population from Excel Category column |
| 15 | **Tool consolidation (16 → 5)** — replaced 16 specialized tools with 5 flexible parameterized tools |
| 16 | **Document profiling** — AI-generated profiles with query hints and tool suggestions stored in JSONB column |

---

## Key Design Decisions

### 5 Flexible Tools Over 16 Specialized

The original 16 tools were consolidated into 5 parameterized tools:

| Before (16 tools) | After (5 tools) |
|---|---|
| `list_documents`, `get_document_sections`, `summarize_document` | `get_document_info` (3 modes) |
| `extract_cost_items`, `extract_dates_deliverables`, `extract_quantities`, `extract_parties`, `extract_percentages` | `query_values` (types parameter) |
| `calculate_cost_summary`, `compare_costs`, `calculate_cost_variance`, `calculate_percentage_of_total`, `calculate_unit_rate` | `aggregate_values` + `compute_result` |
| `compute_difference`, `apply_percentage` | `compute_result` (operations) |
| `search_documents` | `search_documents` (unchanged) |

**Benefits:**
- Simpler agent loop — fewer tool choices to consider
- Easier to maintain — 5 tool implementations vs 16
- More flexible — new query types via parameters, not new tools
- Cleaner system prompt — less routing logic

### Document Profiles (JSONB Column)

Each document gets an AI-generated profile stored in `documents.profile` (JSONB):

```typescript
interface DocumentProfile {
  documentType:        "boq" | "programme" | "contract" | "cost-report" | "risk-register" | "specification" | "procurement" | "other";
  summary:             string;
  language:            string;
  currency:            string;
  keyCategories:       string[];
  availableValueTypes: string[];
  totalCost?:          number;
  sheets?:             SheetProfile[];
  suggestedTools:      string[];
  queryHints:          string[];
}
```

**Why:**
- Agent has context about each document before querying
- Query hints guide category keywords and sheet names
- Suggested tools help agent choose right approach
- Generated once during ingestion, reused for every query

### Function Calling Over Prompt Stuffing

The agent runs targeted SQL queries via GPT tool calls instead of dumping document text into the prompt.

**Benefits:**
- Every factual claim is grounded in tool output
- Token cost stays low regardless of document count
- No hallucinated numbers

### Structured JSON Responses, Never Markdown

The AI returns a typed schema (`title`, `summary`, `sections[]`). The frontend owns all presentation decisions.

**Benefits:**
- Predictable AI output
- UI extensible without backend changes
- Same data renders differently as table, timeline, or fact grid

### Deterministic Excel Extraction

Column classification and value extraction for Excel files are regex-based with LLM schema inference — zero tokens per row.

**Benefits:**
- Ingestion cost proportional to PDF pages, not spreadsheet size
- Consistent type assignment via header keyword normalization
- LLM only used for schema inference, not row-by-row processing

### Two-Pass Ingestion

Every file goes through both:
1. **Chunking** — for semantic search via pgvector
2. **Structured extraction** — for direct SQL queries

**Benefits:**
- `extracted_values` table enables single SQL aggregate queries
- No vector search needed for "what is the total MEP budget?"
- No AI calls at query time

### Async Job Queues for Everything

Both file uploads and question answering use BullMQ + Redis.

**Benefits:**
- HTTP connection closes immediately
- Frontend polls for results
- No socket timeouts on long operations
- Consistent flow for uploads and questions

### Type Normalization

Excel extractor normalizes monetary column types based on header keywords, overriding LLM inference:

```typescript
if (header.includes('outstanding') || header.includes('balance')) return 'outstanding';
if (header.includes('budget') || header.includes('planned')) return 'budget';
if (header.includes('actual') || header.includes('paid')) return 'actual';
if (header.includes('variance') || header.includes('difference')) return 'variance';
```

**Why:** The LLM sometimes marks all monetary columns as `cost` or confuses `outstanding` with `committed_cost`. Header keywords are more reliable.

### Type Aliases in Aggregation

`aggregateValues` expands types to match variants:

```typescript
'budget': ['budget', 'budgeted_cost', 'contract_value'],
'actual': ['actual', 'actual_cost'],
'outstanding': ['outstanding'],
```

**Why:** Allows querying `type: 'budget'` to match `contract_value` from vendor registers.

### Category Column Recognition

Excel extractor now recognizes "Category", "Trade", "Section" columns and populates `section_title` for each extracted value.

**Why:** Enables `groupBy: 'category'` to use actual category names (e.g., "Structural & Facade") instead of regex-extracted code prefixes.

### Cascade Deletes

`chunks` and `extracted_values` both have `ON DELETE CASCADE` on `documents`.

**Benefits:**
- Deleting a document is one SQL statement
- No manual cleanup required

---

## Bugs Fixed

### 1. BOQ Category Aggregation (Phase 14)

**Problem:** Query "Which BOQ category has the highest value?" returned "Data point not found" instead of "Structural & Facade at SAR 47,975,000".

**Root Cause:**
- Excel "Category" column was classified as `reference` instead of `category`
- `section_title` was null for all extracted values
- `groupBy: 'category'` fell back to regex prefix extraction

**Fix:**
- Updated LLM prompt to recognize "Category" columns
- Added `category` role to `ColRole` type
- Updated `aggregateValues` to use `section_title` when available

### 2. Budget vs Actual (Phase 12)

**Problem:** Query "What is the budget vs actual spend?" returned incorrect values. Cost_Tracking sheet was skipped entirely.

**Root Cause:**
- No `label` column existed (Category served as both label and category)
- Extractor required `labelColNum` to get description
- LLM marked Budget, Actual, Variance all as `type: "cost"`

**Fix:**
- Fallback to category column when no label column exists
- Type normalization based on header keywords
- Added handlers for `budget`, `actual`, `variance` types

### 3. Vendor Outstanding (Phase 13)

**Problem:** Query "Total outstanding owed to vendors?" returned 67M instead of 55.5M.

**Root Cause:**
- "Outstanding (SAR)" column was extracted as `committed_cost` or `variance`
- Type normalization didn't handle "outstanding" keyword

**Fix:**
- Added `outstanding` and `contract_value` types
- Updated type normalization to force based on header keywords
- Added type aliases in `aggregateValues`

### 4. Negative Variance Percentages

**Problem:** Variance % for over-budget categories was not extracted (filtered as invalid).

**Root Cause:** Percentage validation required `pct > 0`.

**Fix:** Allow negative percentages for variance columns.

### 5. Tool Proliferation (Phase 15)

**Problem:** 16 specialized tools made agent loop complex and hard to maintain.

**Root Cause:** Each new question type required a new tool.

**Fix:** Consolidated into 5 parameterized tools (`get_document_info`, `search_documents`, `query_values`, `aggregate_values`, `compute_result`).

---

## What I Would Improve Given More Time

### 1. Streaming Responses

**Current:** Agent loop buffers full answer before sending.

**Improvement:** Stream each token to UI as generated using Server-Sent Events or WebSockets.

**Impact:** Significantly faster perceived latency, especially for long answers.

### 2. OCR Support

**Current:** `pdf-parse` cannot read image-based or scanned PDFs.

**Improvement:** Integrate AWS Textract or Azure Document Intelligence.

**Impact:** Usable with majority of real-world construction archives (often scanned).

### 3. Conversation-Aware Agent

**Current:** Agent receives only current question, not prior turns.

**Improvement:** Feed recent message history into agent context.

**Impact:** Follow-up questions ("and what about phase 2?") resolve correctly without repeating context.

### 4. Semantic Answer Cache

**Current:** No caching of answers.

**Improvement:** Embed questions, cache similar queries for 2 hours.

**Impact:** Instant responses to repeated questions, reduced AI costs.

### 5. Authentication & Multi-Tenancy

**Current:** Single-user, trusted network only.

**Improvement:** Add user accounts, document isolation, role-based access.

**Impact:** Production-ready for commercial deployment.

---

## Lessons Learned

### 1. Fewer Tools Are Better

5 flexible tools with parameters are easier to maintain than 16 specialized tools. The agent makes better decisions with fewer choices.

### 2. Document Profiles Add Value

AI-generated query hints and tool suggestions per document help the agent make better decisions without additional AI calls at query time.

### 3. Type Normalization is Critical

LLM schema inference is inconsistent. Header keyword matching is more reliable for monetary columns.

### 4. Section Detection Matters

Excel files often have category columns. Recognizing them enables accurate `groupBy: 'category'` queries.

### 5. Type Aliases Reduce Friction

Users query for "budget" and "actual". The system should match `contract_value`, `budgeted_cost`, etc. transparently.

### 6. Async Queues Prevent Timeouts

Long-running operations (PDF extraction, multi-tool questions) must run in background with polling.

### 7. Structured Output Enables Better UX

Typed JSON responses let the frontend render tables, timelines, and fact grids without parsing markdown.

---

## File Changes Summary

### Core Extraction
- `packages/server/src/extractors/excelExtractor.ts` — LLM schema inference, type normalization, category column handling
- `packages/server/src/extractors/pdfExtractor.ts` — per-page LLM extraction

### Tools
- `packages/server/src/tools/index.ts` — consolidated 5 tools
- `packages/server/src/tools/aggregateValues.ts` — type aliases, category grouping
- `packages/server/src/tools/queryValues.ts` — category filter, type filtering
- `packages/server/src/tools/computeResult.ts` — all arithmetic operations
- `packages/server/src/tools/getDocumentInfo.ts` — list/sections/summarize modes
- `packages/server/src/tools/utils.ts` — semantic category resolution

### Services
- `packages/server/src/services/agent.ts` — tool loop, document context from profiles
- `packages/server/src/services/openai.ts` — system prompt with 5 tool routing
- `packages/server/src/services/profileGenerator.ts` — AI document profiling with query hints

### Frontend
- `packages/web/src/components/StructuredAnswer.tsx` — section renderer
- `packages/web/src/app/page.tsx` — main chat interface

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js 18, Express, TypeScript |
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS |
| **AI** | OpenAI (`gpt-5.4-mini` extraction & profiling, `gpt-4o-mini` agent, `text-embedding-3-small`) |
| **Database** | PostgreSQL 14+ with `pgvector`, Drizzle ORM |
| **Queue** | BullMQ + Redis |
| **Parsing** | `pdf-parse`, `exceljs` |

---

## Repository Structure

```
doc-agent/
├── packages/
│   ├── server/              # Backend
│   │   ├── src/
│   │   │   ├── db/          # Drizzle schema (documents.profile JSONB)
│   │   │   ├── extractors/  # PDF + Excel extraction
│   │   │   ├── parsers/     # PDF + Excel parsing
│   │   │   ├── routes/      # API endpoints
│   │   │   ├── services/    # AI, embeddings, queues, profiling
│   │   │   ├── tools/       # 5 agent tools
│   │   │   └── utils/       # Chunking, validators
│   │   └── test-docs/       # Sample BOQs, schedules, vendor registers
│   │
│   └── web/                 # Frontend
│       ├── src/
│       │   ├── app/         # Next.js pages
│       │   ├── components/  # UI components
│       │   └── lib/         # API client
│       └── .env.local
│
├── docker-compose.yml       # PostgreSQL + Redis
├── .env.example             # Environment template
├── README.md                # User documentation
├── HOW_IT_WORKS.md          # System architecture
├── NOTES.md                 # This file
└── CLAUDE.md                # Claude Code context
```

---

## License

MIT

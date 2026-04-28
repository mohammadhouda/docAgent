# DocAgent — AI Document Q&A Agent

## What It Does

DocAgent is an AI-powered document analysis system for construction and engineering projects. Load PDFs and Excel files (BOQs, contracts, specs, schedules), then ask natural language questions. The AI extracts, cites, and returns structured answers — not raw markdown — so the frontend renders polished cards, timelines, tables, and fact grids.

Built on GPT function calling: the model never guesses. Every claim is grounded in tool output with a source citation. Answers are stored in a conversation history tied to a PostgreSQL database.

---

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL with the `pgvector` extension
- Redis (for the async ingestion and ask job queues)

### Setup

```bash
git clone <repo>
cd doc-agent
cp .env.example .env
# Edit .env — fill in OPENAI_API_KEY, DATABASE_URL, REDIS_URL
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drag-and-drop documents, then ask questions.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | No | `redis://localhost:6379` | BullMQ job queue |
| `PORT` | No | `3001` | Backend port |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin |
| `DOCUMENTS_PATH` | No | `./documents` | Default folder for ingest route |

---

## Architecture

```
packages/
  server/   Express + TypeScript API   :3001
  web/      Next.js + Tailwind UI      :3000
```

### Ingestion Pipeline (per file)

```
Upload / Folder path
        │
        ▼
  1. Parse  — PDF page-by-page (pdf-parse); Excel row-batches (exceljs)
        │
        ▼
  2. Chunk  — ~6 000 chars, 200-char overlap, tagged with page/sheet metadata
        │
        ▼
  3. Embed  — text-embedding-3-small, batched 100 texts/request → stored in pgvector
        │
        ▼
  4. Classify — gpt-4o-mini reads opening content → type, project, currency, parties
        │
        ▼
  5. Extract — structured values pulled deterministically from Excel columns;
               per-page with gpt-4o-mini for PDFs (costs, dates, parties, quantities, %)
        │
        ▼
  6. Store  — document + chunks + extracted_values written to PostgreSQL
```

File uploads are queued as BullMQ jobs (one worker, concurrency 1) so the UI responds immediately and polls job state while processing happens in the background.

### Query Pipeline (per question)

Both file uploads and questions use the same BullMQ-backed async pattern:

```
POST /api/ask  →  enqueue job  →  202 { jobId }    (returns in ~5 ms)
      │
      ▼ (background worker)
Agent loop  (max 5 iterations, model: gpt-4o-mini)
      │
      ├── GPT calls tools → tools query PostgreSQL → results returned
      │   (multiple tools can be called in the same iteration)
      │
      └── GPT synthesises tool results → stores result in Redis
            │
            ▼ (frontend polls GET /api/ask/jobs/:jobId every 1 s)
      { title, summary, sections[] }  ←  rendered by frontend
```

The socket closes immediately after enqueuing; the frontend polls `GET /api/ask/jobs/:jobId` until `state: "completed"`. Granular status text ("Calling calculate cost summary…") is forwarded from the worker's in-process status map to the loading indicator.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js, Express, TypeScript |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| AI | OpenAI `gpt-4o-mini` (function calling) |
| Embeddings | `text-embedding-3-small` via pgvector |
| Database | PostgreSQL + Drizzle ORM |
| Job queue | BullMQ + Redis |
| PDF parsing | `pdf-parse` (per-page text extraction) |
| Excel parsing | `exceljs` (XLSX / XLS / CSV) |
| Validation | Zod |
| File upload | Multer |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/upload` | Upload files — `multipart/form-data`, field `files`; returns job IDs |
| `GET` | `/api/upload/jobs/:id` | Poll a single upload job's state |
| `POST` | `/api/ingest` | Ingest all supported files from a server folder path `{ folderPath }` |
| `GET` | `/api/documents` | List all ingested documents with metadata |
| `DELETE` | `/api/documents` | Clear all documents |
| `POST` | `/api/ask` | Enqueue a question `{ question, history?, conversationId? }` — returns `{ jobId }` (202) |
| `GET` | `/api/ask/jobs/:id` | Poll ask job — returns `{ state, status }` or `{ state: "completed", result }` |
| `POST` | `/api/conversations` | Create a new conversation |
| `GET` | `/api/conversations/:id/messages` | Fetch full message history |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |

---

## Agent Tools

The AI chooses from 11 tools. Routing rules are enforced in the system prompt so the most specific tool is always preferred over `search_documents`.

| Tool | Purpose |
|---|---|
| `list_documents` | Called once per session — returns all loaded documents with IDs, sheet names, metadata |
| `get_document_sections` | Discovers sheet names, cost totals per sheet, and item-code prefixes (A, B, M, E…) — answers "what sections/trades are in this BOQ?" |
| `search_documents` | Semantic (pgvector cosine) or keyword (PostgreSQL FTS) search across all chunks |
| `extract_cost_items` | Line-item costs from `extracted_values`; filterable by `minAmount`, `maxAmount`, `category` keyword |
| `calculate_cost_summary` | Grouped cost totals by sheet/trade; filterable by `category` keyword (matches sheet name or item label) |
| `compare_costs` | Cross-document cost comparison; filterable by `category` and/or `documentIds` |
| `extract_dates_deliverables` | Dates, milestones, and deadlines sorted chronologically |
| `extract_quantities` | Measured quantities (m², m³, ton…) filterable by `unit` and `minValue` |
| `extract_parties` | Named parties (contractor, client, consultant…) filterable by `role` keyword |
| `extract_percentages` | VAT, retention, markup, discount rates |
| `summarize_document` | Samples beginning/middle/end of a document for scope-of-work questions |

---

## Structured JSON Response Format

The AI never returns plain text or markdown. Every final answer is a JSON object:

```json
{
  "title": "Short answer title",
  "summary": "One-sentence TL;DR (optional)",
  "sections": [
    { "type": "paragraph", "content": "Plain prose." },
    {
      "type": "key_facts",
      "title": "Project Details",
      "items": [{ "label": "Project No.", "value": "ANT-2024-0087", "citation": "Contract.pdf | Page 1" }]
    },
    {
      "type": "timeline",
      "title": "Key Milestones",
      "items": [{ "date": "1 April 2024", "label": "Commencement", "citation": "Contract.pdf | Page 7" }]
    },
    {
      "type": "table",
      "title": "Cost Breakdown",
      "headers": ["Item", "Description", "Amount (SAR)"],
      "rows": [["A-001", "Pile Foundation", "12,500,000.00"]]
    },
    {
      "type": "list",
      "title": "Scope Items",
      "items": [{ "text": "Foundation and substructure works", "citation": "Spec.pdf | Page 3" }]
    },
    {
      "type": "parties",
      "title": "Contract Parties",
      "items": [{ "role": "Employer", "name": "Al Nakheel Development Co.", "citation": "Contract.pdf | Page 1" }]
    }
  ]
}
```

Section types: `paragraph` · `key_facts` · `timeline` · `table` · `list` · `parties`

If the model returns non-JSON (edge case), the backend wraps the raw text in a `paragraph` section so the frontend never breaks.

---

## Excel Extraction Detail

Excel files go through two independent pipelines:

1. **Chunking** — rows formatted as `header: value | header: value` text, batched in groups of 50, chunked and embedded for search.

2. **Structured extraction** — a deterministic column classifier (`excelExtractor.ts`) reads each sheet's header row, identifies column types (cost, date, quantity, party, percentage…), and stores individual values in the `extracted_values` table. Key behaviours:
   - Smart header row detection: skips merged title rows, finds first row with ≥2 distinct values
   - Cost column priority: Committed > Total Amount > Amount > Qty × Rate fallback
   - Summary sheets (no item-number column) are excluded from line-item extraction
   - Total/Grand Total rows are skipped; item codes prepended to labels (`A-001: Description`)

---

## Database Schema

Five tables in PostgreSQL:

| Table | Purpose |
|---|---|
| `documents` | File metadata + AI-extracted type, project, currency, parties, summary |
| `chunks` | Document segments with `vector(1536)` embeddings for semantic search |
| `extracted_values` | Structured values (cost, date, quantity, party, percentage, reference) per row/page |
| `conversations` | Chat sessions |
| `messages` | Per-message content + structured answer JSONB + sources JSONB |

---

## Edge Cases Handled

- Empty folder → returns `documentsLoaded: 0` with warning
- Corrupt or image-only PDF → skipped with warning, others continue
- PDF > 50 pages → first 50 pages processed with warning
- Excel merged title rows → header detection skips them automatically
- No item-number column in Excel sheet → sheet treated as summary, cost items not extracted
- Total/Grand Total rows → skipped by label pattern match
- No documents loaded → structured paragraph response, no tool calls attempted
- Invalid/traversal folder path → blocked by Zod + 404
- OpenAI timeout → 90 s AbortController, returns 504
- AI returns non-JSON → fallback wraps as `paragraph` section

---

## Known Limitations

- **OCR** — `pdf-parse` cannot extract text from image-based/scanned PDFs
- **Streaming** — answers are buffered and delivered via polling; no token-by-token streaming
- **Authentication** — no auth; all documents and conversations are globally accessible
- **Multi-user isolation** — one shared document store per server instance

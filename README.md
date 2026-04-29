# DocAgent

AI-powered document Q&A for construction and engineering projects. Upload BOQs, contracts, specs, and schedules, then ask natural language questions. Answers come back as structured, cited cards rather than raw text.

**Key Features:**
- Multi-format support (PDF, XLSX, XLS, CSV)
- Semantic search powered by pgvector + OpenAI embeddings
- Agentic query engine with 15 specialized tools
- Structured, cited responses (tables, timelines, key facts, parties)
- Async job processing with BullMQ + Redis
- Full conversation persistence with message history

---

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** 14+ with the [`pgvector`](https://github.com/pgvector/pgvector) extension enabled
- **Redis** 6+ (for BullMQ job queues)
- **OpenAI API Key** with access to `gpt-4o-mini` and `text-embedding-3-small`

---

## Quick Start

### 1. Clone and Configure

```bash
git clone <repo>
cd doc-agent
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:password@localhost:5432/docagent

# Optional (defaults shown)
REDIS_URL=redis://localhost:6379
PORT=3001
CORS_ORIGIN=http://localhost:3000
DOCUMENTS_PATH=./documents
```

### 2. Install and run

```bash
npm install
npm run dev
```

- **Frontend:** http://localhost:3000
- **Backend:** http://localhost:3001

> **Note:** The server runs database migrations automatically on startup (`CREATE TABLE IF NOT EXISTS`). No manual migration step required.

---

## Docker Setup (Recommended)

Use the included `docker-compose.yml` to spin up PostgreSQL and Redis:

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** on `localhost:5432` with `pgvector` pre-installed
- **Redis** on `localhost:6379`

Update `.env` accordingly:

```env
DATABASE_URL=postgresql://docagent:docagent@localhost:5432/docagent
REDIS_URL=redis://localhost:6379
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key (requires `gpt-4o-mini` and `text-embedding-3-small`) |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string with `pgvector` extension |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis URL for BullMQ job queues |
| `PORT` | No | `3001` | Backend API server port |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin for CORS |
| `DOCUMENTS_PATH` | No | `./documents` | Default folder for `/api/ingest` route |

---

## Loading Documents

### Via UI (Drag and Drop)

Drag and drop files onto the sidebar in the UI. Supported formats:

- **PDF** — parsed page-by-page using `pdf-parse`
- **Excel** (`.xlsx`, `.xls`) — parsed row-by-row using `exceljs`
- **CSV** — parsed as single-sheet data

### Via API (Server Folder Ingest)

Ingest all documents from a server folder:

```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{ "folderPath": "/absolute/path/to/docs" }'
```

### Upload via API (Multipart)

Upload files directly via multipart form:

```bash
curl -X POST http://localhost:3001/api/upload \
  -F "files=@document1.pdf" \
  -F "files=@document2.xlsx"
```

Returns: `{ jobs: [{ id, fileName }] }` — poll each job at `/api/upload/jobs/:id`

---

## Document Processing Pipeline

Each file goes through **6 stages**:

```
Parse → Chunk → Embed → Classify → Extract → Store
```

| Stage | PDF | Excel/CSV |
|---|---|---|
| **Parse** | `pdf-parse` per page (max 50 pages) | `exceljs` row batches (50 rows/batch) |
| **Chunk** | ~6,000 chars, 200-char overlap (prefers paragraph/sentence boundaries) | Same, with `sheetName + rowRange` metadata |
| **Embed** | `text-embedding-3-small` → 1,536-dim vectors (batches of 100) | Same |
| **Classify** | `gpt-4o-mini` reads first 2 chunks → type, project, currency, parties, summary | Same |
| **Extract** | `gpt-4o-mini` per page → structured values (costs, dates, quantities, parties, percentages) | Deterministic column classifier (zero LLM tokens) |
| **Store** | PostgreSQL via Drizzle ORM (`documents`, `chunks`, `extracted_values`) | Same |

> **Job Processing:** Upload jobs are processed by a background BullMQ worker (concurrency: 1). The UI polls for progress.

---

## How Questions Work

`POST /api/ask` enqueues a job and returns immediately (`202`). A worker (concurrency: 3) runs an **agent loop** that calls up to **15 structured tools** against PostgreSQL — no arithmetic is ever done by the model itself. The frontend polls every second until the job completes.

### Agent Architecture

- **Model:** `gpt-4o-mini` with function calling
- **Max iterations:** 5 tool-call loops per question
- **Tool protocol:** Each tool is described in terms of the **user question it answers**, not the SQL it runs
- **Routing rules:** Explicit system prompt guidance on which tool to use per question type
- **Truth constraint:** Every number/date/party must come from tool output — no hallucination

### Tool Catalog

| Tool | Answers questions like… |
|---|---|
| `list_documents` | "What files do you have?" / "What documents are loaded?" |
| `get_document_sections` | "What sections/trades are in this BOQ?" / "What sheets does this file have?" |
| `search_documents` | General content, clauses, narrative, specs (semantic search via pgvector) |
| `extract_cost_items` | "What are the most expensive items?" / "List all electrical line items" |
| `calculate_cost_summary` | "What is the total cost?" / "Break down the cost by trade" |
| `compare_costs` | "Which bid is cheaper?" / "Show costs side by side" |
| `calculate_cost_variance` | "How much more expensive is A than B?" / "What is the cost difference?" |
| `calculate_percentage_of_total` | "What share of the budget is MEP?" / "What percentage is civil works?" |
| `calculate_unit_rate` | "What is the rate per m³ for piling?" / "Cost per m²?" |
| `compute_difference` | "What is the difference between X and Y?" / "By how much?" |
| `extract_dates_deliverables` | "What are the key dates?" / "When is the submission deadline?" |
| `extract_quantities` | "What is the total concrete volume?" / "How many elevators?" |
| `extract_parties` | "Who is the main contractor?" / "List all subcontractors" |
| `extract_percentages` | "What is the VAT rate?" / "What retention applies?" |
| `summarize_document` | "Summarize this document" / "What is the scope of work?" |

### Semantic Category Matching

Tools that accept a `category` parameter resolve it **semantically**, not with plain substring matching:

1. Embeds the term using `text-embedding-3-small`
2. Finds document sheets with most similar chunk embeddings (cosine distance < 0.65)
3. Builds `ILIKE ANY(patterns)` filter — original term + resolved sheet names

| User input | Resolves to |
|---|---|
| `"electrical"` | `%electrical%` + nearest sheets (e.g. `%Electrical Works%`) |
| `"ELC"` | `%ELC%` + nearest sheets |
| `"elec"` | `%elec%` + nearest sheets |
| `"MEP"` | `%MEP%` + nearest sheets |

---

## Answer Format

Every answer is a **structured JSON object** — never raw markdown. The frontend renders it as typed cards:

```json
{
  "title": "Short title",
  "summary": "One-sentence TL;DR (optional)",
  "sections": [
    { "type": "paragraph", "content": "..." },
    { "type": "key_facts", "title": "...", "items": [{ "label": "...", "value": "...", "citation": "..." }] },
    { "type": "table", "title": "...", "headers": ["Col1", "Col2"], "rows": [["val1", "val2"]] },
    { "type": "timeline", "title": "...", "items": [{ "date": "...", "label": "...", "citation": "..." }] },
    { "type": "list", "title": "...", "items": [{ "text": "...", "citation": "..." }] },
    { "type": "parties", "title": "...", "items": [{ "role": "...", "name": "...", "citation": "..." }] }
  ]
}
```

### Section Types

| Type | Renders as | Best for |
|---|---|---|
| `paragraph` | Plain text block | Narrative, scope descriptions |
| `key_facts` | Label/value grid | Contract values, dates, key metrics |
| `table` | Striped HTML table | Cost breakdowns, line items |
| `timeline` | Vertical timeline | Milestones, deliverables |
| `list` | Bulleted list | Scope items, requirements |
| `parties` | Role + company cards | Contractors, subcontractors, consultants |

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check — returns `{ status: "ok" }` |
| `POST` | `/api/upload` | Upload files (`multipart/form-data`, field `files`) — returns `{ jobs: [{ id, fileName }] }` |
| `GET` | `/api/upload/jobs/:id` | Poll upload job — returns `{ state, result?, error? }` |
| `POST` | `/api/ingest` | Ingest a server folder `{ folderPath }` (synchronous) |
| `GET` | `/api/documents` | List all ingested documents |
| `DELETE` | `/api/documents` | Delete all documents (cascade deletes chunks + extracted_values) |
| `POST` | `/api/ask` | Enqueue a question `{ question, history?: [...], conversationId? }` — returns `202 { jobId, requestId }` |
| `GET` | `/api/ask/jobs/:id` | Poll ask job — returns `{ state, status }` or `{ state: "completed", result }` |
| `POST` | `/api/conversations` | Create a conversation `{ title }` — returns `{ id }` |
| `GET` | `/api/conversations/:id/messages` | Fetch message history for a conversation |
| `DELETE` | `/api/conversations/:id` | Delete a conversation and all messages |

### Example: Ask a Question

```bash
# 1. Enqueue question
curl -X POST http://localhost:3001/api/ask \
  -H "Content-Type: application/json" \
  -d '{ "question": "What is the total MEP cost?", "conversationId": "abc-123" }'

# Response: 202 { "jobId": "job_456", "requestId": "req_789" }

# 2. Poll for result
curl http://localhost:3001/api/ask/jobs/job_456

# Response when active: { "state": "active", "status": "Calling calculate cost summary..." }
# Response when done:   { "state": "completed", "result": { "answer": {...}, "sources": [...], "toolsUsed": [...] } }
```

---

## Project Structure

```
doc-agent/
├── packages/
│   ├── server/          # Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── db/      # Database schema (Drizzle ORM)
│   │   │   ├── extractors/  # PDF + Excel value extraction
│   │   │   ├── parsers/     # PDF + Excel text parsing
│   │   │   ├── routes/      # API endpoints
│   │   │   ├── services/    # OpenAI, embeddings, metadata
│   │   │   ├── tools/       # 15 agent tools (SQL queries)
│   │   │   ├── utils/       # Chunking, formatting helpers
│   │   │   └── index.ts     # Server entry point
│   │   └── test-docs/   # Sample documents for testing
│   │
│   └── web/             # Next.js 14 frontend
│       ├── src/
│       │   ├── app/     # App router pages
│       │   └── components/
│       │       ├── ChatInterface.tsx    # Main chat UI
│       │       ├── StructuredAnswer.tsx # JSON answer renderer
│       │       └── ...
│       └── .env.local   # Frontend environment
│
├── docker-compose.yml   # PostgreSQL + Redis services
├── .env.example         # Environment template
└── package.json         # Workspace root (runs both packages)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Express, TypeScript, Node.js 18 |
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS |
| **AI** | OpenAI (`gpt-4o-mini` function calling, `text-embedding-3-small`) |
| **Database** | PostgreSQL 14+ with `pgvector` (HNSW index), Drizzle ORM |
| **Queue** | BullMQ + Redis |
| **Parsing** | `pdf-parse` (PDFs), `exceljs` (Excel) |

---

## Known Limitations

| Limitation | Workaround / Future |
|---|---|
| No OCR — image-based PDFs not supported | Pre-process with OCR tool (e.g., Tesseract) |
| No streaming responses | Polling-based UX (1s interval) |
| No authentication or multi-user isolation | Single-user / trusted network deployment only |
| Max 50 pages per PDF (configurable) | Split large PDFs before upload |
| No answer caching (Redis keeps results 2h) | Consider adding semantic answer cache for repeated questions |

---

## Development

### Run in development

```bash
npm run dev   # Runs both server (3001) and web (3000) concurrently
```

### Build for production

```bash
npm run build   # Builds both packages
npm run start   # Starts both servers
```

### Database

The server auto-creates tables on startup. Schema is defined in `packages/server/src/db/schema.ts` using Drizzle ORM.

Key tables:
- `documents` — file metadata, classification
- `chunks` — text segments + embeddings (pgvector)
- `extracted_values` — structured extractions (costs, dates, parties, etc.)
- `conversations` — chat sessions
- `messages` — user/assistant message history

---

## License

MIT

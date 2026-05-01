# DocAgent

**AI-powered document intelligence for construction and engineering projects.**

Upload BOQs, contracts, specs, and schedules — then ask natural language questions. Get instant, structured answers with citations back to the source documents.

---

## Quick Links

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Docker Setup](#docker-setup-recommended)
- [API Reference](#api-reference)
- [Document Processing](#document-processing-pipeline)
- [Available Tools](#available-tools-16-total)

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-format Support** | PDF, Excel (`.xlsx`, `.xls`), CSV — parsed with format-specific extractors |
| **Semantic Search** | pgvector + OpenAI embeddings find meaning, not just keywords |
| **Structured Extraction** | Costs, quantities, dates, parties, percentages auto-extracted to SQL tables |
| **16 Specialized Tools** | Agent chooses the right tool for each question type |
| **Cited Responses** | Every fact links back to source document + location |
| **Async Processing** | BullMQ + Redis queues handle uploads and questions in background |
| **Structured Answers** | JSON responses render as tables, timelines, fact grids, party cards |

---

## Example Questions

**Cost & Budget:**
- "What is the total project budget?"
- "Break down costs by trade"
- "Which BOQ category has the highest value?"
- "Compare costs across multiple documents"

**Schedule & Dates:**
- "What are the key milestones?"
- "When is the submission deadline?"
- "Show the project timeline"

**Vendors & Contracts:**
- "What is the total outstanding amount owed to vendors?"
- "How many vendors have a non-zero balance?"
- "Who is the main contractor?"

**Budget Tracking:**
- "What is the budget vs. actual spend?"
- "Which cost categories are over budget?"
- "What percentage of the budget is MEP?"

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | 18+ | Runtime for server and frontend |
| **PostgreSQL** | 14+ with `pgvector` | Vector embeddings for semantic search |
| **Redis** | 6+ | BullMQ job queues for async processing |
| **OpenAI API Key** | `gpt-4o-mini`, `gpt-5.4-mini`, `text-embedding-3-small` | AI extraction and embeddings |

---

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
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

> **Note:** Database migrations run automatically on server startup. Tables are created if they don't exist.

---

## Docker Setup (Recommended)

Use the included `docker-compose.yml` to run PostgreSQL and Redis:

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** on `localhost:5444` with `pgvector` pre-installed
- **Redis** on `localhost:6379`

Update `.env`:

```env
DATABASE_URL=postgresql://docagent:docagent@localhost:5444/docagent
REDIS_URL=redis://localhost:6379
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string with `pgvector` |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis URL for BullMQ |
| `PORT` | No | `3001` | Backend API port |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin |
| `DOCUMENTS_PATH` | No | `./documents` | Default folder for `/api/ingest` |

---

## Loading Documents

### Via UI (Drag & Drop)

Drag files onto the sidebar. Supported formats:
- **PDF** — page-by-page parsing with `pdf-parse`
- **Excel** (`.xlsx`, `.xls`) — section-aware parsing with `exceljs`
- **CSV** — single-sheet data

### Via API

**Ingest from server folder:**

```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{ "folderPath": "/absolute/path/to/docs" }'
```

**Upload files directly:**

```bash
curl -X POST http://localhost:3001/api/upload \
  -F "files=@BOQ_Riyadh_Tower.xlsx" \
  -F "files=@Project_Schedule.pdf"
```

Returns: `{ jobs: [{ id, fileName }] }` — poll at `/api/upload/jobs/:id`

---

## Document Processing Pipeline

Every file goes through **6 stages**:

```
Upload → Parse → Chunk → Embed → Extract → Store
```

| Stage | PDF | Excel/CSV |
|---|---|---|
| **Parse** | `pdf-parse` (max 50 pages, coordinate-based line reconstruction) | `exceljs` (section detection, auto-groups by headers) |
| **Chunk** | Token-bounded (~800 text, ~500 tables), 75-token smart overlap | Same token-bounded approach, section-aware |
| **Embed** | `text-embedding-3-small` → 1,536-dim vectors (batches of 100) | Same |
| **Classify** | `gpt-4o-mini` reads first 2 chunks → document type, project, currency, parties | Same |
| **Extract** | `gpt-5.4-mini` per page (5 concurrent) → costs, dates, quantities, parties, percentages | `gpt-5.4-mini` schema inference → column role classification |
| **Store** | PostgreSQL via Drizzle ORM (`documents`, `chunks`, `extracted_values`) | Same |

### Type Normalization

The Excel extractor normalizes monetary column types based on header keywords:

| Header contains | Type assigned |
|---|---|
| "budget", "planned" | `budget` |
| "actual", "paid", "spent", "to date" | `actual` |
| "outstanding", "balance", "payable" | `outstanding` |
| "variance", "difference" | `variance` |
| "contract" | `contract_value` |
| "committed" | `committed_cost` |

This ensures consistent querying regardless of LLM inference variations.

---

## How Questions Work

`POST /api/ask` enqueues a job and returns immediately (`202`). A background worker runs an **agent loop**:

1. **Model:** `gpt-4o-mini` with function calling
2. **Max iterations:** 5 tool-call loops per question
3. **Tool protocol:** Each tool answers a specific question type
4. **Truth constraint:** Every number/date/party must come from tool output

### Agent Architecture

```
User Question
    ↓
Agent Loop (gpt-4o-mini)
    ↓
Choose Tool → Execute SQL → Return Result
    ↓
Repeat up to 5 times
    ↓
Synthesize Answer (structured JSON)
    ↓
Frontend renders as typed cards
```

---

## Available Tools (16 Total)

| Tool | Answers Questions Like |
|---|---|
| `list_documents` | "What files do you have?" / "What documents are loaded?" |
| `get_document_sections` | "What sections/trades are in this BOQ?" / "What sheets does this file have?" |
| `search_documents` | General content, clauses, narrative, specs (semantic search via pgvector) |
| `extract_cost_items` | "What are the most expensive items?" / "List all MEP line items" |
| `calculate_cost_summary` | "What is the total cost?" / "Break down cost by trade" |
| `compare_costs` | "Which bid is cheaper?" / "Show costs side by side" |
| `calculate_cost_variance` | "How much more expensive is A than B?" / "What is the cost difference?" |
| `calculate_percentage_of_total` | "What share of the budget is MEP?" / "What percentage is civil works?" |
| `apply_percentage` | "What is the VAT-inclusive total?" / "Apply 5% retention" |
| `calculate_unit_rate` | "What is the rate per m³ for piling?" / "Cost per m²?" |
| `compute_difference` | "What is the difference between X and Y?" / "By how much?" |
| `extract_dates_deliverables` | "What are the key dates?" / "When is the submission deadline?" |
| `extract_quantities` | "What is the total concrete volume?" / "How many elevators?" |
| `extract_parties` | "Who is the main contractor?" / "List all subcontractors" |
| `extract_percentages` | "What is the VAT rate?" / "What retention applies?" |
| `summarize_document` | "Summarize this document" / "What is the scope of work?" |
| `aggregate_values` | "Total budget vs actual" / "Which categories are over budget?" |
| `query_values` | "List all items above 500k SAR" / "Show in-progress tasks" |

### Semantic Category Matching

Tools that accept a `category` parameter resolve it **semantically**, not with substring matching:

1. Embeds the term using `text-embedding-3-small`
2. Finds document sheets with most similar chunk embeddings (cosine distance < 0.65)
3. Builds `ILIKE ANY(patterns)` filter — original term + resolved sheet names

| User Input | Resolves To |
|---|---|
| `"electrical"` | `%electrical%` + nearest sheets (e.g., `%Electrical Works%`) |
| `"ELC"` | `%ELC%` + nearest sheets |
| `"MEP"` | `%MEP%` + nearest sheets |

---

## Answer Format

Every answer is **structured JSON** — never raw markdown. The frontend renders typed cards:

```json
{
  "title": "Vendor Outstanding Balance Summary",
  "summary": "Total outstanding is SAR 55,597,500 across 14 vendors.",
  "sections": [
    {
      "type": "key_facts",
      "title": "Outstanding Vendor Balances",
      "items": [
        { "label": "Total outstanding amount", "value": "55,597,500 SAR", "citation": "Vendor_Payment_Register.xlsx | Sheet: Vendor_Payments" },
        { "label": "Vendors with non-zero balance", "value": "14 of 15", "citation": "Vendor_Payment_Register.xlsx | Sheet: Vendor_Payments" }
      ]
    },
    {
      "type": "table",
      "title": "Breakdown by Vendor",
      "headers": ["Vendor", "Outstanding (SAR)"],
      "rows": [
        ["Glass Tech LLC", "18,500,000"],
        ["Otis Elevator Saudi", "5,800,000"]
      ]
    }
  ]
}
```

### Section Types

| Type | Renders As | Best For |
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
| `POST` | `/api/upload` | Upload files (`multipart/form-data`, field `files`) |
| `GET` | `/api/upload/jobs/:id` | Poll upload job — returns `{ state, result?, error? }` |
| `POST` | `/api/ingest` | Ingest server folder `{ folderPath }` (synchronous) |
| `GET` | `/api/documents` | List all ingested documents |
| `DELETE` | `/api/documents` | Delete all documents (cascade deletes chunks + extracted_values) |
| `POST` | `/api/ask` | Enqueue question `{ question, history?, conversationId? }` — returns `202 { jobId, requestId }` |
| `GET` | `/api/ask/jobs/:id` | Poll ask job — returns `{ state, status }` or `{ state: "completed", result }` |
| `POST` | `/api/conversations` | Create conversation `{ title }` — returns `{ id }` |
| `GET` | `/api/conversations/:id/messages` | Fetch message history |
| `DELETE` | `/api/conversations/:id` | Delete conversation and messages |

### Example: Ask a Question

```bash
# 1. Enqueue question
curl -X POST http://localhost:3001/api/ask \
  -H "Content-Type: application/json" \
  -d '{ "question": "What is the total outstanding owed to vendors?", "conversationId": "abc-123" }'

# Response: 202 { "jobId": "job_456", "requestId": "req_789" }

# 2. Poll for result
curl http://localhost:3001/api/ask/jobs/job_456

# Active: { "state": "active", "status": "Calling aggregate values..." }
# Done:   { "state": "completed", "result": { "answer": {...}, "sources": [...], "toolsUsed": [...] } }
```

---

## Project Structure

```
doc-agent/
├── packages/
│   ├── server/              # Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── db/          # Database schema (Drizzle ORM)
│   │   │   ├── extractors/  # PDF + Excel structured extraction
│   │   │   ├── parsers/     # PDF + Excel text parsing
│   │   │   ├── routes/      # API endpoints
│   │   │   ├── services/    # OpenAI, embeddings, metadata, queues
│   │   │   ├── tools/       # 16 agent tools (SQL queries)
│   │   │   ├── utils/       # Chunking, validators, error handling
│   │   │   └── index.ts     # Server entry point
│   │   └── test-docs/       # Sample BOQs, schedules, vendor registers
│   │
│   └── web/                 # Next.js 14 frontend
│       ├── src/
│       │   ├── app/         # App router pages
│       │   ├── components/  # ChatInterface, StructuredAnswer, UploadDrop
│       │   └── lib/         # API client, utilities
│       └── .env.local
│
├── docker-compose.yml       # PostgreSQL + Redis
├── .env.example             # Environment template
├── README.md                # This file
├── HOW_IT_WORKS.md          # System architecture deep dive
├── NOTES.md                 # Build notes and development history
└── CLAUDE.md                # Claude Code context file
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Express, TypeScript, Node.js 18 |
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS |
| **AI** | OpenAI (`gpt-5.4-mini` extraction, `gpt-4o-mini` agent, `text-embedding-3-small`) |
| **Database** | PostgreSQL 14+ with `pgvector` (HNSW index), Drizzle ORM |
| **Queue** | BullMQ + Redis |
| **Parsing** | `pdf-parse` (coordinate-based), `exceljs` (section-aware) |

---

## Known Limitations

| Limitation | Workaround / Future |
|---|---|
| No OCR — image-based PDFs not supported | Pre-process with OCR (e.g., AWS Textract, Azure Document Intelligence) |
| No streaming responses | Polling-based UX (1s interval); consider SSE or WebSockets |
| No authentication | Single-user / trusted network deployment only |
| Max 50 pages per PDF (configurable) | Split large PDFs before upload |
| No conversation-aware agent | Agent receives only current question, not prior turns |
| No answer caching | Consider semantic cache for repeated questions |

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

### Database Schema

Tables auto-create on startup. Schema defined in `packages/server/src/db/schema.ts`:

- `documents` — file metadata, classification, currency, parties
- `chunks` — text segments + embeddings (pgvector, HNSW index)
- `extracted_values` — structured extractions (costs, dates, quantities, parties, percentages, outstanding, contract values)
- `conversations` — chat sessions
- `messages` — user/assistant message history

---

## License

MIT

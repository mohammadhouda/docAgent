# DocAgent

AI-powered document Q&A for construction and engineering projects. Upload BOQs, contracts, specs, and schedules — then ask natural language questions. Answers come back as structured, cited cards rather than raw text.

---

## Prerequisites

- Node.js 18+
- PostgreSQL with the [`pgvector`](https://github.com/pgvector/pgvector) extension enabled
- Redis

---

## Setup

```bash
git clone <repo>
cd doc-agent
cp .env.example .env
```

Fill in `.env`:

```env
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:password@localhost:5432/docagent
REDIS_URL=redis://localhost:6379
```

Then:

```bash
npm install
npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:3001

The server runs database migrations automatically on startup (`CREATE TABLE IF NOT EXISTS`). No migration step needed.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | No | `redis://localhost:6379` | BullMQ job queue |
| `PORT` | No | `3001` | Backend port |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin |
| `DOCUMENTS_PATH` | No | `./documents` | Folder used by the `/api/ingest` route |

---

## Loading Documents

**Drag and drop** files onto the sidebar in the UI (PDF, XLSX, XLS, CSV).

Or ingest a server-side folder via the API:

```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{ "folderPath": "/absolute/path/to/docs" }'
```

Each file goes through: **parse → chunk → embed → classify → extract → store**.

- PDF: `pdf-parse` per page → ~6 000-char chunks with 200-char overlap → `text-embedding-3-small` embeddings → `gpt-4o-mini` per-page value extraction
- Excel: `exceljs` row batches → deterministic column classifier (no tokens) → extracted values stored directly

Upload jobs are processed by a background BullMQ worker (concurrency 1). The UI polls for progress.

---

## How Questions Work

`POST /api/ask` enqueues a job and returns immediately (`202`). A worker (concurrency 3) runs an agent loop that calls up to **14 structured tools** against PostgreSQL — no arithmetic is ever done by the model itself. The frontend polls every second until the job completes.

Tools available to the agent:

| Tool | Purpose |
|---|---|
| `list_documents` | List all loaded documents with metadata |
| `get_document_sections` | Discover sheet names, item counts, and code prefixes |
| `search_documents` | Semantic (pgvector) or keyword full-text search |
| `extract_cost_items` | Line-item costs with amount and category filters |
| `calculate_cost_summary` | Cost totals grouped by section or trade |
| `compare_costs` | Side-by-side cost breakdown across N documents |
| `calculate_cost_variance` | Absolute and percentage difference between two documents |
| `calculate_percentage_of_total` | Category share of the overall project cost |
| `calculate_unit_rate` | Cost ÷ quantity per BOQ row |
| `compute_difference` | Arithmetic difference between two known values |
| `extract_dates_deliverables` | Dates, milestones, and schedule events |
| `extract_quantities` | Volumes, areas, counts, and weights |
| `extract_parties` | Contractors, clients, consultants, subcontractors |
| `extract_percentages` | VAT, retention, markup, and discount rates |
| `summarize_document` | Sampled excerpt (beginning, middle, end) for scope questions |

---

## Answer Format

Every answer is a structured JSON object — never raw markdown. The frontend renders it as typed cards:

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

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/upload` | Upload files (`multipart/form-data`, field `files`) — returns `{ jobs: [{ id, fileName }] }` |
| `GET` | `/api/upload/jobs/:id` | Poll upload job — returns `{ state, result?, error? }` |
| `POST` | `/api/ingest` | Ingest a server folder `{ folderPath }` (synchronous) |
| `GET` | `/api/documents` | List all ingested documents |
| `DELETE` | `/api/documents` | Delete all documents |
| `POST` | `/api/ask` | Enqueue a question `{ question, history?: [...], conversationId? }` — returns `202 { jobId, requestId }` |
| `GET` | `/api/ask/jobs/:id` | Poll ask job — returns `{ state, status }` or `{ state: "completed", result }` |
| `POST` | `/api/conversations` | Create a conversation `{ title }` — returns `{ id }` |
| `GET` | `/api/conversations/:id/messages` | Fetch message history |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |

---

## Tech Stack

| | |
|---|---|
| Backend | Express, TypeScript, Node.js 18 |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| AI | OpenAI function calling + `text-embedding-3-small` |
| Database | PostgreSQL + pgvector (HNSW index) + Drizzle ORM |
| Queue | BullMQ + Redis |
| Parsing | `pdf-parse` (PDFs), `exceljs` (Excel) |

---

## Known Limitations

- No OCR — image-based PDFs are not supported
- No streaming responses
- No authentication or multi-user document isolation

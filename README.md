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

Each file goes through: parse → chunk → embed → classify → extract → store. Upload jobs are processed by a background BullMQ worker; the UI polls for progress.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/upload` | Upload files (`multipart/form-data`, field `files`) — returns `{ jobs: [{ id, fileName }] }` |
| `GET` | `/api/upload/jobs/:id` | Poll upload job state |
| `POST` | `/api/ingest` | Ingest a server folder `{ folderPath }` (synchronous) |
| `GET` | `/api/documents` | List all ingested documents |
| `DELETE` | `/api/documents` | Delete all documents |
| `POST` | `/api/ask` | Enqueue a question `{ question, conversationId? }` — returns `202 { jobId }` |
| `GET` | `/api/ask/jobs/:id` | Poll ask job — returns `{ state, status }` or `{ state: "completed", result }` |
| `POST` | `/api/conversations` | Create a conversation |
| `GET` | `/api/conversations/:id/messages` | Fetch message history |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |

---

## Tech Stack

| | |
|---|---|
| Backend | Express, TypeScript, Node.js 18 |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| AI | OpenAI `gpt-4o-mini` (function calling) + `text-embedding-3-small` |
| Database | PostgreSQL + pgvector + Drizzle ORM |
| Queue | BullMQ + Redis |
| Parsing | `pdf-parse`, `exceljs` |

# DocAgent — Build Notes

## AI Coding Agent

Built with Claude Code assisting across architecture, code generation, refactoring, debugging, and documentation throughout all 11 build phases.

---

## How Long It Took

Approximately **15–18 hours** across 11 iterative development phases.

The project was built using an AI-assisted workflow with Claude Code as a development accelerator, but the engineering direction, architecture decisions, feature priorities, validation, and refinements were led by me throughout the process.

Each phase started from a product or technical objective such as improving semantic search, introducing structured JSON responses, or refactoring parts of the system. I then used Claude Code to help implement changes faster across multiple files, while I reviewed outputs, tested behavior, identified issues, adjusted requirements, and guided the next iteration.

The workflow was less about handing everything to AI and more about combining engineering judgment with AI-assisted execution to move faster while maintaining control over the system design and quality.

---

## Build Phases

| Phase | What was built |
|---|---|
| 1 | Monorepo scaffold — npm workspaces, shared tsconfig, concurrently dev runner |
| 2 | Parse & ingest — PDF per-page + Excel row-batch, chunker with overlap, Multer upload route |
| 3 | AI agent — GPT function-calling loop, 5 initial tools, document metadata extraction |
| 4 | Frontend — Next.js chat interface, drag-and-drop upload, source citations, tool badges |
| 5 | Semantic search — `text-embedding-3-small` embeddings, pgvector cosine similarity, FTS fallback |
| 6 | Structured JSON responses — typed section schema, system prompt rewrite, `StructuredAnswer.tsx` renderer |
| 7 | PostgreSQL persistence — Drizzle ORM, pgvector, BullMQ upload queue, conversation history |
| 8 | Structured value extraction — deterministic Excel column classifier, per-page LLM extraction for PDFs |
| 9 | Tool expansion (5 → 16) — `calculate_cost_summary`, `compare_costs`, `extract_quantities`, `extract_parties`, `extract_percentages`, `get_document_sections`; `category` filter added |
| 10 | Refactor pass — dead code removed, misleading names fixed, model name bug corrected, broken polling removed |
| 11 | Async ask queue — `POST /api/ask` converted from blocking to BullMQ job, eliminates socket hangouts |

---

## Key Design Decisions

**Function calling over prompt stuffing**
The agent runs targeted SQL queries via GPT tool calls instead of dumping document text into the prompt. Every factual claim in the answer is grounded in tool output. Token cost stays low regardless of how many documents are loaded.

**Structured JSON responses, never markdown**
The AI returns a typed schema (`title`, `summary`, `sections[]`). The frontend owns all presentation decisions — the same data renders differently as a table, timeline, or fact grid depending on the section type. This makes the AI output predictable and the UI extensible without touching the backend.

**Deterministic Excel extraction**
Column classification and value extraction for Excel files are fully regex-based — zero tokens per row. LLM extraction is only used for PDFs where layout is unpredictable. This keeps ingestion cost proportional to PDF pages, not spreadsheet size.

**Two-pass ingestion**
Every file goes through both chunking (for search) and structured extraction (for direct SQL queries). The `extracted_values` table lets the agent answer "what is the total MEP budget?" with a single SQL aggregate — no vector search, no AI calls at query time.

**Async job queues for everything**
Both file uploads and question answering use BullMQ + Redis. The HTTP connection closes immediately; the frontend polls for results. This eliminates socket hangouts on long operations and makes both flows consistent.

**Cascade deletes**
`chunks` and `extracted_values` both have `ON DELETE CASCADE` on `documents`. Deleting a document is a single SQL statement — no manual cleanup.

---

## What I Would Improve Given More Time

**Streaming responses**
The agent loop buffers the full answer before sending. Streaming each token to the UI as it's generated would make the product feel significantly faster, especially for long answers. The BullMQ polling approach would need to be replaced or augmented with Server-Sent Events or WebSockets.

**OCR support**
`pdf-parse` cannot read image-based or scanned PDFs — a common format in construction document management. Integrating a proper OCR pipeline (e.g. AWS Textract or Azure Document Intelligence) would make the system usable with the majority of real-world project archives.

**Conversation-aware agent**
The agent currently receives only the current question. It does not have access to prior turns in the conversation. Feeding recent message history into the agent's context would allow follow-up questions ("and what about phase 2?") to resolve correctly without repeating context.


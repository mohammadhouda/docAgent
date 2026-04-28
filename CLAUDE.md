# DocAgent — Claude Code Context

## Project layout
npm workspace monorepo. Two packages:
- `packages/server` — Express + TypeScript API, port 3001
- `packages/web` — Next.js 14 + Tailwind, port 3000

Run both: `npm run dev` from project root.
TypeScript check (server): `npx tsc -p packages/server/tsconfig.json --noEmit`
TypeScript check (web): `npm run build --workspace=packages/web`

## Stack
PostgreSQL + pgvector + Drizzle ORM + raw `pg` pool
BullMQ + Redis (async jobs for both uploads and ask requests)
OpenAI `gpt-5.4-mini` (function calling agent) + `text-embedding-3-small` (embeddings)

## Key files
- `packages/server/src/services/agent.ts` — GPT function-calling loop, model: `gpt-5.4-mini`
- `packages/server/src/services/openai.ts` — SYSTEM_PROMPT (tool routing rules, output format)
- `packages/server/src/tools/index.ts` — all 15 tool definitions + executeTool dispatcher
- `packages/server/src/tools/` — one file per tool implementation
- `packages/server/src/services/queue.ts` — ingestion + ask BullMQ workers
- `packages/server/src/routes/ask.ts` — POST enqueues job (202), GET /jobs/:id polls
- `packages/server/src/db/schema.ts` — Drizzle table definitions
- `packages/server/src/extractors/excelExtractor.ts` — deterministic column classifier
- `packages/server/src/extractors/pdfExtractor.ts` — per-page LLM extraction, model: `gpt-5.4-mini`
- `packages/web/src/components/StructuredAnswer.tsx` — section dispatcher/renderer
- `packages/web/src/lib/api.ts` — frontend API client

## Database tables
documents, chunks (vector(1536) HNSW), extracted_values, conversations, messages

## 15 tools (all query PostgreSQL, zero tokens at query time)
list_documents, get_document_sections, search_documents,
extract_cost_items, calculate_cost_summary, compare_costs,
calculate_cost_variance, calculate_percentage_of_total,
calculate_unit_rate, compute_difference,
extract_dates_deliverables, extract_quantities,
extract_parties, extract_percentages, summarize_document

## Adding a new tool — checklist
1. Create `packages/server/src/tools/myTool.ts` (export async function)
2. Import + add tool definition in `packages/server/src/tools/index.ts`
3. Add case in `executeTool` switch in `packages/server/src/tools/index.ts`
4. Add routing rule in SYSTEM_PROMPT in `packages/server/src/services/openai.ts`

## Adding a new answer section type — checklist
1. Add interface to `packages/server/src/types/index.ts`
2. Add to `AnswerSection` union type
3. Mirror type in `packages/web/src/lib/api.ts`
4. Add renderer in `packages/web/src/components/StructuredAnswer.tsx`
5. Document in SYSTEM_PROMPT output format section

## Coding standards
- No comments unless the WHY is non-obvious
- No dead code, no unused exports
- TypeScript strict — no `any`
- AI never does arithmetic — always call compute_difference / calculation tools
- AI returns structured JSON only, never markdown

import dotenv from 'dotenv';
import path from 'path';

// Load .env from the monorepo root (doc-agent/.env)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const config = {
  port:               parseInt(process.env.PORT ?? '3001', 10),
  corsOrigin:         process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  openaiApiKey:       process.env.OPENAI_API_KEY ?? '',
  databaseUrl:        process.env.DATABASE_URL ?? '',
  redisUrl:           process.env.REDIS_URL ?? 'redis://localhost:6379',
  documentsPath:      process.env.DOCUMENTS_PATH ?? path.join(process.cwd(), 'documents'),
  maxPdfPages:        50,
  maxExcelRows:       1000,
  // Token-based chunk sizing (1 token ≈ 4 chars).
  // Text/clause chunks target 800 tokens; table chunks target 500 (denser content).
  targetTokensText:   800,
  targetTokensTable:  500,
  overlapTokens:      75,   // carried into the next chunk at paragraph / row boundaries
  minChunkTokens:     40,   // chunks smaller than this are merged into the preceding chunk
  maxAgentIterations: 5,
  requestTimeoutMs:   90000,
};

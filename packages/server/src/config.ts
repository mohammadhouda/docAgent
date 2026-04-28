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
  chunkSize:          6000,
  chunkOverlap:       200,
  maxAgentIterations: 5,
  requestTimeoutMs:   90000,
};

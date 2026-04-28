import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createIngestionWorker, createAskWorker } from './services/queue.js';
import { errorHandler } from './utils/errorHandler.js';
import askRouter from './routes/ask.js';
import ingestRouter from './routes/ingest.js';
import documentsRouter from './routes/documents.js';
import uploadRouter from './routes/upload.js';
import conversationsRouter from './routes/conversations.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/ask', askRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/conversations', conversationsRouter);

app.use(errorHandler);

// Run database migrations, then start the workers and the server
runMigrations()
  .then(() => {
    createIngestionWorker();
    createAskWorker();
    console.log('[Worker] Ingestion and ask workers started');
    app.listen(config.port, () => {
      console.log(`[Server] Running on http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    console.error('[Server] Failed to run migrations, exiting:', err);
    process.exit(1);
  });


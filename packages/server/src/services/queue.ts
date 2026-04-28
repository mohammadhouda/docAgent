import { Queue, Worker, Job } from 'bullmq';
import fs from 'fs';
import { config } from '../config.js';
import { ingestFile, IngestedFileResult } from './ingestion.js';
import { runAgent } from './agent.js';
import { conversationStore } from './conversationStore.js';
import { deleteRequestStatus } from './requestStatus.js';
import { AskResponse, ConversationMessage } from '../types/index.js';

export interface IngestJobData {
  filePath: string;
  fileName: string;
}

export interface AskJobData {
  question:       string;
  history:        ConversationMessage[];
  conversationId: string | null;
  requestId:      string;
}

// Parse redis://host:port into BullMQ connection options
function redisOpts() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379'),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export const ingestionQueue = new Queue<IngestJobData, IngestedFileResult>('ingestion', {
  connection: redisOpts(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24 }, // keep 24 h so frontend can poll result
    removeOnFail:    { age: 60 * 60 * 24 },
  },
});

export const askQueue = new Queue<AskJobData, AskResponse>('ask', {
  connection: redisOpts(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 2 }, // keep 2 h so frontend can poll result
    removeOnFail:    { age: 60 * 60 * 2 },
  },
});

export function createAskWorker() {
  const worker = new Worker<AskJobData, AskResponse>(
    'ask',
    async (job: Job<AskJobData, AskResponse>) => {
      const { question, history, conversationId, requestId } = job.data;
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const result = await runAgent(question, controller.signal, history, requestId);
        if (conversationId) {
          await conversationStore.addMessage(conversationId, {
            role:      'assistant',
            answer:    result.answer,
            sources:   result.sources,
            toolsUsed: result.toolsUsed,
          });
        }
        return result;
      } finally {
        clearTimeout(timeoutId);
        deleteRequestStatus(requestId);
      }
    },
    { connection: redisOpts(), concurrency: 3 },
  );

  worker.on('failed', (job, err) => {
    if (job) {
      deleteRequestStatus(job.data.requestId);
      console.error(`[AskWorker] Job ${job.id} failed: ${err.message}`);
    }
  });

  return worker;
}

export function createIngestionWorker() {
  const worker = new Worker<IngestJobData, IngestedFileResult>(
    'ingestion',
    async (job: Job<IngestJobData, IngestedFileResult>) => {
      const { filePath, fileName } = job.data;
      try {
        return await ingestFile(filePath, fileName);
      } finally {
        try { fs.unlinkSync(filePath); } catch { /* already cleaned up */ }
      }
    },
    {
      connection: redisOpts(),
      concurrency: 1, // PDF parsing can be resource-intensive, so we process one at a time to avoid overload
    },
  );

  worker.on('failed', (job, err) => {
    if (job) {
      try { fs.unlinkSync(job.data.filePath); } catch { /* already cleaned up */ }
      console.error(`[Worker] ${job.data.fileName} failed: ${err.message}`);
    }
  });

  return worker;
}

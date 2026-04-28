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

// This function parses the Redis connection URL from the configuration and returns an object with the connection options for BullMQ. It supports URLs with optional authentication and ensures that the password is properly decoded if present. This allows the application to connect to a Redis instance for managing the job queues used in document ingestion and question answering.
function redisOpts() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379'),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

// This module sets up two BullMQ queues: one for document ingestion and another for processing user questions. It defines the data structures for the jobs in each queue and provides functions to create workers that will process the jobs. The ingestion worker handles the parsing and storage of uploaded documents, while the ask worker implements the agent loop to generate answers based on user questions and conversation history. Both workers include error handling to ensure that any issues during job processing are logged and that temporary resources are cleaned up appropriately.
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

// This function creates a worker for processing user questions. It listens to the 'ask' queue and executes the runAgent function for each job, which implements the core agent loop to generate answers based on the user's question and conversation history. The worker is configured to process multiple jobs concurrently to allow for responsive interactions. If a job fails, it logs the error and ensures that any associated request status is cleaned up to prevent stale states in the application.
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

// This function creates a worker for processing document ingestion jobs. It listens to the 'ingestion' queue and executes the ingestFile function for each job, which handles the parsing and storage of uploaded documents. The worker is configured to process one job at a time to avoid overloading the server, especially since PDF parsing can be resource-intensive. If a job fails, it logs the error and ensures that any temporary files are cleaned up to prevent storage issues.
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

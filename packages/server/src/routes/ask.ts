import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Job } from 'bullmq';
import { askSchema } from '../utils/validators.js';
import { askQueue } from '../services/queue.js';
import { conversationStore } from '../services/conversationStore.js';
import { getRequestStatus } from '../services/requestStatus.js';
import { createError } from '../utils/errorHandler.js';

const router = Router();

// This route handles incoming questions from clients. It validates the request body against the defined schema, generates a unique request ID, and enqueues a job in the askQueue for asynchronous processing. If a conversation ID is provided, it also stores the user's question in the conversation history for context in future interactions. The response includes the job ID and request ID for tracking purposes.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(createError(parsed.error.errors[0].message, 400));
    }

    const { question, history, conversationId } = parsed.data;
    const requestId = uuidv4();

    if (conversationId) {
      await conversationStore.addMessage(conversationId, { role: 'user', content: question });
    }

    const job = await askQueue.add('ask', {
      question,
      history,
      conversationId: conversationId ?? null,
      requestId,
    });

    res.status(202).json({ jobId: job.id, requestId });
  } catch (err) {
    next(err);
  }
});

// This route allows clients to check the status of their question-answering request by providing the job ID. It returns the current state of the job (e.g., pending, completed, failed) and includes the result or error message if the job has finished processing. This enables clients to poll for updates on their requests in a structured way.
router.get('/jobs/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await Job.fromId(askQueue, req.params.jobId);
    if (!job) return next(createError('Job not found', 404));

    const state  = await job.getState();
    const status = getRequestStatus(job.data.requestId);

    if (state === 'completed') {
      return res.json({ state: 'completed', result: job.returnvalue });
    }
    if (state === 'failed') {
      return res.json({ state: 'failed', error: job.failedReason ?? 'Unknown error' });
    }

    res.json({ state, status: status ?? 'Processing…' });
  } catch (err) {
    next(err);
  }
});

export default router;

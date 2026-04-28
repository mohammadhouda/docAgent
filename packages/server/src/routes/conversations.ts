import { Router, Request, Response, NextFunction } from 'express';
import { conversationStore } from '../services/conversationStore.js';
import { createError } from '../utils/errorHandler.js';

const router = Router();

// This route creates a new conversation with an optional title. It generates a unique conversation ID and returns it in the response. The title is truncated to 120 characters to prevent excessively long titles from being stored or displayed.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const title = String(req.body?.title ?? 'New Conversation').slice(0, 120);
    const id = await conversationStore.create(title);
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

// This route retrieves the messages for a specific conversation by its ID. It checks if the conversation exists and returns the message history in the response. If the conversation is not found, it responds with a 404 error.
router.get('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!await conversationStore.exists(id)) {
      return next(createError('Conversation not found', 404));
    }
    const msgs = await conversationStore.getMessages(id);
    res.json({ messages: msgs });
  } catch (err) {
    next(err);
  }
});

// This route deletes a conversation by its ID. It checks if the conversation exists and deletes it from the store. If the conversation is not found, it responds with a 404 error. On successful deletion, it returns a success message in the response.
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await conversationStore.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;

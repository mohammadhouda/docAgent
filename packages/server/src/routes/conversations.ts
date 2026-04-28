import { Router, Request, Response, NextFunction } from 'express';
import { conversationStore } from '../services/conversationStore.js';
import { createError } from '../utils/errorHandler.js';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const title = String(req.body?.title ?? 'New Conversation').slice(0, 120);
    const id = await conversationStore.create(title);
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

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

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await conversationStore.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;

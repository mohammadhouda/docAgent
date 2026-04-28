import { Router, Request, Response, NextFunction } from 'express';
import { documentStore } from '../services/documentStore.js';

const router = Router();

router.delete('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await documentStore.clear();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (_req: Request, res: Response) => {
  const docs = (await documentStore.getAll()).map((doc) => ({
    id:          doc.id,
    fileName:    doc.fileName,
    fileType:    doc.fileType,
    totalPages:  doc.totalPages,
    totalSheets: doc.totalSheets,
    chunkCount:  doc.chunks.length,
    hasEmbeddings: doc.chunks.some((c) => !!c.embedding),
    metadata:    doc.metadata,
    ingestedAt:  doc.ingestedAt,
  }));

  res.json({ documents: docs });
});

export default router;

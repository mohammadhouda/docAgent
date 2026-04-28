import { Router, Request, Response, NextFunction } from 'express';
import { documentStore } from '../services/documentStore.js';

const router = Router();

// This route deletes all documents from the document store. It is a bulk operation that clears the entire collection of documents, which can be useful for resetting the state during development or testing. The response indicates whether the operation was successful.
router.delete('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await documentStore.clear();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// This route retrieves a list of all documents in the document store along with their metadata. It returns an array of document summaries, including details such as file name, type, page count, chunk count, and ingestion date. This allows clients to view the available documents and their attributes without needing to access the full content.
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

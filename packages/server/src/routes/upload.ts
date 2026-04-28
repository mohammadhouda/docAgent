import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { SUPPORTED_EXTENSIONS } from '../parsers/index.js';
import { documentStore } from '../services/documentStore.js';
import { ingestionQueue } from '../services/queue.js';
import { createError } from '../utils/errorHandler.js';

const router = Router();

const upload = multer({
  dest: os.tmpdir(),
  fileFilter: (_req, file, cb) => {
    cb(null, SUPPORTED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 100 * 1024 * 1024 },
});

// POST /api/upload — queue ingestion jobs and return immediately
router.post(
  '/',
  upload.array('files', 100),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;

      if (!files || files.length === 0) {
        return next(createError('No supported files received (.pdf, .xlsx, .xls, .csv)', 400));
      }

      // Clear existing documents synchronously before queuing so the user
      // sees an immediate empty state while jobs are processing
      await documentStore.clear();

      const jobs: { id: string; fileName: string }[] = [];

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const tmpPath = `${file.path}${ext}`;

        try {
          fs.renameSync(file.path, tmpPath);
          const job = await ingestionQueue.add('ingest', {
            filePath: tmpPath,
            fileName: file.originalname,
          });
          jobs.push({ id: job.id!, fileName: file.originalname });
        } catch (err) {
          // Clean up this file if we couldn't queue it
          try { fs.unlinkSync(tmpPath); }  catch { /* ignore */ }
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
          throw err;
        }
      }

      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/upload/jobs/:id — poll a single job's state
router.get('/jobs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await ingestionQueue.getJob(req.params.id);
    if (!job) {
      return next(createError('Job not found', 404));
    }

    const state  = await job.getState();
    const result = state === 'completed' ? job.returnvalue  : undefined;
    const error  = state === 'failed'    ? job.failedReason : undefined;

    res.json({ id: job.id, fileName: job.data.fileName, state, result, error });
  } catch (err) {
    next(err);
  }
});

export default router;

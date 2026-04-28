import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { ingestSchema } from '../utils/validators.js';
import { SUPPORTED_EXTENSIONS } from '../parsers/index.js';
import { documentStore } from '../services/documentStore.js';
import { ingestFile, IngestedFileResult } from '../services/ingestion.js';
import { createError } from '../utils/errorHandler.js';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(createError(parsed.error.errors[0].message, 400));
    }

    const { folderPath } = parsed.data;

    if (!fs.existsSync(folderPath)) {
      return next(createError(`Folder not found: ${folderPath}`, 404));
    }
    if (!fs.statSync(folderPath).isDirectory()) {
      return next(createError('Path is not a directory', 400));
    }

    const fileNames = fs.readdirSync(folderPath).filter((f) =>
      SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()),
    );

    if (fileNames.length === 0) {
      return res.json({
        documentsLoaded: 0,
        documents: [],
        warnings: ['No supported files found (.pdf, .xlsx, .xls, .csv)'],
      });
    }

    await documentStore.clear();

    const results: IngestedFileResult[] = [];
    const warnings: string[] = [];

    for (const fileName of fileNames) {
      try {
        const result = await ingestFile(path.join(folderPath, fileName), fileName);
        results.push(result);
        warnings.push(...result.warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Ingest] Skipping ${fileName}: ${message}`);
        warnings.push(`[${fileName}] Skipped due to error: ${message}`);
      }
    }

    res.json({
      documentsLoaded: results.length,
      documents: results.map(({ name, type, chunks }) => ({ name, type, chunks })),
      warnings,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

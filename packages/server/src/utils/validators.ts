import { z } from 'zod';
import path from 'path';

const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(5000),
});

export const askSchema = z.object({
  question:       z.string().min(1, 'Question cannot be empty').max(2000, 'Question too long'),
  history:        z.array(conversationMessageSchema).max(20).optional().default([]),
  conversationId: z.string().uuid('Invalid conversation ID').optional(),
});

export const ingestSchema = z.object({
  folderPath: z
    .string()
    .min(1, 'Folder path cannot be empty')
    .transform((p) => path.resolve(p))
    .refine(
      (p) => !p.includes('..'),
      'Invalid folder path: directory traversal not allowed',
    ),
});

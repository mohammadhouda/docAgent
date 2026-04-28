import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  details?: string;
}

// This is a centralized error handling middleware for the Express server. It captures any errors thrown in the route handlers or other middleware, logs the error details, and sends a structured JSON response with an appropriate HTTP status code and error message.

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  console.error(`[Error] ${err.message}`, err.stack);

  // Headers already sent — cannot modify response, just end it
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(statusCode).json({
    error: err.message ?? 'Internal server error',
    details: err.details,
  });
}

export function createError(message: string, statusCode = 500, details?: string): AppError {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

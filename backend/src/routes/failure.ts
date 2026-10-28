import type { Response } from "express";
import { BusinessError } from "../domain/error.js";

// Answers a BusinessError with its own status; anything else goes on to the app's error handler.
export function failure(res: Response, error: unknown) {
  if (error instanceof BusinessError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

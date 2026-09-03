import type { NextFunction, Request, Response } from "express";

// Central error handler — the old server had none (sync throws crashed the
// request). Returns JSON without changing any endpoint's documented behavior.
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[Error] " + err.message);
  res.status(500).json({ error: "Internal server error" });
}

// Safety net for async rejections that escape route handlers (Express 4 does
// not catch them). Prevents a single Redis blip from crashing the process.
export function bootstrapProcessHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    console.error(
      "[process] unhandledRejection:",
      reason instanceof Error ? reason.stack || reason.message : String(reason),
    );
  });
  process.on("uncaughtException", (err: Error) => {
    console.error("[process] uncaughtException:", err.stack || err.message);
  });
}

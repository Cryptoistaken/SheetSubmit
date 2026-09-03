import type { NextFunction, Request, Response } from "express";

export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|did|session|code|key|secret|auth|password)=)[^&]*/g, "$1[redacted]");
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log("[API] " + req.method + " " + redactUrl(req.originalUrl) + " → " + res.statusCode + " (" + ms + "ms)");
  });
  next();
}

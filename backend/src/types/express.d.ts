import type { StoredFile } from "../lib/shared";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      file?: StoredFile;
      files?: StoredFile[];
      fileIdx?: number;
    }
  }
}

export {};

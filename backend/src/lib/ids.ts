import crypto from "node:crypto";

export function genFileId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

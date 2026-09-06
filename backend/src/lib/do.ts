import { repository } from "./pg";

export async function rpc(namespace: "index" | "files" | "pools", name: string, op: string, args: Record<string, unknown> = {}) {
  return repository(namespace, name, op, args);
}

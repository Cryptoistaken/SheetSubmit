const buckets = new Map<string, number[]>();
export function checkRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = buckets.get(key) || [];
  const fresh = arr.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) { buckets.set(key, fresh); return false; }
  fresh.push(now);
  buckets.set(key, fresh);
  if (buckets.size > 2000) buckets.delete(buckets.keys().next().value as string);
  return true;
}
export function ipKey(c: any, ns: string): string {
  const ip = c.req.header("cf-connecting-ip") || "anon";
  return `${ns}:${ip}`;
}

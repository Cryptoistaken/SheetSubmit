import { base, percentile, report, request, session } from "./lib";

const endpoint = Bun.env.STRESS_ENDPOINT || "/files";
const requests = Math.max(1, Number(Bun.env.STRESS_REQUESTS || 100));
const concurrency = Math.max(1, Math.min(requests, Number(Bun.env.STRESS_CONCURRENCY || 10)));
const expected = (Bun.env.STRESS_EXPECTED_STATUS || "200").split(",").map(Number);

async function run() {
  if (!session) throw new Error("Set SESSION_TOKEN in test/.env");
  let next = 0;
  const samples: Awaited<ReturnType<typeof request>>[] = [];
  const worker = async () => { while (true) { const index = next++; if (index >= requests) return; samples.push(await request(endpoint)); } };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const unexpected = samples.filter((sample) => !expected.includes(sample.status));
  console.log(`API ${base}${endpoint} | requests=${requests} concurrency=${concurrency} expected=${expected.join(",")}`);
  report("stress", samples);
  if (unexpected.length) { for (const sample of unexpected.slice(0, 5)) console.log(`unexpected ${sample.status}: ${typeof sample.body === "string" ? sample.body.slice(0, 200) : JSON.stringify(sample.body).slice(0, 200)}`); throw new Error(`${unexpected.length}/${requests} unexpected responses`); }
}

if (import.meta.main) await run();

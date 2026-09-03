// POST /__redeploy — redeploy THIS service on Railway (used by redeploy.bat after
// pushing the image). Self-redeploys via RAILWAY_TOKEN (env var on the service) +
// Railway's own injected RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID — no IDs or
// URLs hardcoded anywhere.
import { Router } from "express";
import crypto from "node:crypto";
import { asyncRoute } from "../middleware/asyncRoute";

export const deployRouter = Router();

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const REDEPLOY_QUERY =
  "mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }";

deployRouter.post("/__redeploy", asyncRoute(async (req, res) => {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!token || !serviceId || !environmentId) {
    res.status(503).json({ ok: false, error: "RAILWAY_TOKEN / RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID not set" });
    return;
  }
  const provided = req.headers.authorization || "";
  const expected = "Bearer " + token;
  if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  try {
    const r = await fetch(RAILWAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        query: REDEPLOY_QUERY,
        variables: { serviceId, environmentId },
      }),
    });
    const body = (await r.json().catch(() => ({}))) as {
      errors?: unknown[];
      data?: { serviceInstanceRedeploy?: boolean };
    };
    if (!r.ok || body.errors) {
      res.status(502).json({ ok: false, errors: body.errors });
      return;
    }
    res.json({ ok: body.data?.serviceInstanceRedeploy === true, data: body.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
}));
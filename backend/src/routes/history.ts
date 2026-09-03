// Version history routes — ported from the old server (API contract unchanged).
import { Router } from "express";
import type { Row } from "../lib/shared";
import { createForkFile, updateUserFilesAtomic } from "../services/files";
import {
  getHistoryMeta,
  histMetaKey,
  materializeVersion,
  snapshotHistory,
} from "../services/history";
import { getJSON, setJSON } from "../services/redis";
import { requireAuth, requireFileAccess } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";

export const historyRouter = Router();

historyRouter.get("/:id/history", requireAuth, requireFileAccess, asyncRoute(async (req, res) => {
  try {
    const meta = await getHistoryMeta(req.params.id);
    console.log("[Hist] list file=" + req.params.id + " versions=" + meta.length);
    res.json(meta);
  } catch (e) {
    console.error("[Hist] list error file=" + req.params.id + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to read history" });
  }
}));

historyRouter.get("/:id/history/:v", requireAuth, requireFileAccess, asyncRoute(async (req, res) => {
  try {
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.id, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const meta = await getHistoryMeta(req.params.id);
    const rec = meta.find((m) => m.v === v);
    console.log("[Hist] materialize file=" + req.params.id + " v" + v + " rows=" + rows.length);
    res.json({ v, rows, action: rec ? rec.action : null, ts: rec ? rec.ts : null });
  } catch (e) {
    console.error("[Hist] materialize error file=" + req.params.id + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to read version" });
  }
}));

historyRouter.post("/:id/history/:v/restore", requireAuth, requireFileAccess, asyncRoute(async (req, res) => {
  try {
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.id, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    // Git-revert semantics: commit the *current* state as a new 'restore'
    // version first, so the revert itself is always revertible.
    const curRows = await getJSON<Row[]>("rows:" + req.params.id);
    const snapV = await snapshotHistory(req.params.id, "restore", curRows || []);
    if (snapV === null) {
      res.status(500).json({ error: "Failed to snapshot current state before restore" });
      return;
    }
    await setJSON("rows:" + req.params.id, rows);
    const bumped = await updateUserFilesAtomic(req.userId || "", (files) => {
      const idx = files.findIndex((f) => f.id === req.params.id);
      if (idx === -1) return null;
      files[idx].updatedAt = Date.now();
      return files[idx];
    });
    if (bumped === null) { res.status(500).json({ error: "Conflict saving files" }); return; }
    console.log("[Hist] restore file=" + req.params.id + " v" + v + " rows=" + rows.length);
    res.json({ ok: true, v, rows });
  } catch (e) {
    console.error("[Hist] restore error file=" + req.params.id + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to restore version" });
  }
}));

historyRouter.post("/:id/history/:v/name", requireAuth, requireFileAccess, asyncRoute(async (req, res) => {
  try {
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const meta = (await getJSON<{ v: number; name: string | null }[]>(histMetaKey(req.params.id))) || [];
    let rec: { v: number; name: string | null } | null = null;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].v === v) {
        rec = meta[i];
        break;
      }
    }
    if (!rec) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    rec.name = String((req.body as { name?: unknown }).name || "");
    await setJSON(histMetaKey(req.params.id), meta);
    console.log("[Hist] name file=" + req.params.id + " v" + v + " name=\"" + rec.name + "\"");
    res.json({ ok: true, meta });
  } catch (e) {
    console.error("[Hist] name error file=" + req.params.id + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to name version" });
  }
}));

historyRouter.post("/:id/history/:v/fork", requireAuth, requireFileAccess, asyncRoute(async (req, res) => {
  try {
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.id, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const file = await createForkFile(req.file || null, rows, req.userId || "");
    console.log("[Hist] fork file=" + req.params.id + " v" + v + " → " + file.id + " rows=" + rows.length);
    res.json({ ok: true, file, rows });
  } catch (e) {
    console.error("[Hist] fork error file=" + req.params.id + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to fork version" });
  }
}));

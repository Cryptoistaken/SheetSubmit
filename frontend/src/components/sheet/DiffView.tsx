import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useSheetStore } from "@/stores/sheetStore";
import { getVersionRows } from "@/stores/versionCache";
import type { ColumnDef, VersionMeta } from "@/lib/types";
import type { DiffLine, DiffResult } from "./diff";
import { vComputeDiff } from "./diff";

function Mark({ text, q }: { text: string; q: string }) {
  const qq = q.trim();
  if (!qq) return <>{text}</>;
  const tl = text.toLowerCase();
  const ql = qq.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const idx = tl.indexOf(ql, i);
    if (idx < 0) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={k++}>{text.slice(idx, idx + ql.length)}</mark>);
    i = idx + ql.length;
  }
  return <>{out}</>;
}

interface NumInfo {
  on: number;
  nn: number;
}

function UnifiedRows({
  lines,
  nums,
  idxs,
  q,
}: {
  lines: DiffLine[];
  nums: NumInfo[];
  idxs: number[];
  q: string;
}) {
  return (
    <>
      {idxs.map((i) => {
        const ln = lines[i];
        const { on, nn } = nums[i];
        return (
          <div key={i} className={"ghdiff-line " + ln.type}>
            <span className="ghdiff-num">{on || ""}</span>
            <span className="ghdiff-num">{nn || ""}</span>
            <div className="ghdiff-code">
              <Mark text={ln.text} q={q} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function SplitRows({
  lines,
  nums,
  idxs,
  q,
}: {
  lines: DiffLine[];
  nums: NumInfo[];
  idxs: number[];
  q: string;
}) {
  const pairs: { left: number; right: number }[] = [];
  let i = 0;
  while (i < idxs.length) {
    const li = idxs[i];
    const ln = lines[li];
    if (ln.type === "del") {
      const nxt = idxs[i + 1];
      if (nxt !== undefined && lines[nxt].type === "add") {
        pairs.push({ left: li, right: nxt });
        i += 2;
      } else {
        pairs.push({ left: li, right: -1 });
        i += 1;
      }
    } else if (ln.type === "ctx") {
      pairs.push({ left: li, right: li });
      i += 1;
    } else {
      pairs.push({ left: -1, right: li });
      i += 1;
    }
  }
  return (
    <>
      {pairs.map((p, k) => {
        const left = p.left >= 0 ? lines[p.left] : null;
        const right = p.right >= 0 ? lines[p.right] : null;
        return (
          <div key={k} className="ghdiff-pair">
            <div className={"ghdiff-side" + (left ? " " + left.type : " blank")}>
              <span className="ghdiff-num">{left ? nums[p.left].on : ""}</span>
              <div className="ghdiff-code">
                {left ? <Mark text={left.text} q={q} /> : null}
              </div>
            </div>
            <div className={"ghdiff-side" + (right ? " " + right.type : " blank")}>
              <span className="ghdiff-num">{right ? nums[p.right].nn : ""}</span>
              <div className="ghdiff-code">
                {right ? <Mark text={right.text} q={q} /> : null}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function DiffView({
  fileId,
  rec,
  prev,
  fileName,
  typeName,
  columns: columnsProp,
  adminMode: adminModeProp,
}: {
  fileId: string;
  rec: VersionMeta;
  prev: VersionMeta | null;
  fileName: string;
  typeName: string;
  columns?: ColumnDef[];
  adminMode?: boolean;
}) {
  const storeColumns = useSheetStore((s) => s.columns);
  const storeAdminMode = useSheetStore((s) => s.adminMode);
  const columns = columnsProp ?? storeColumns;
  const adminMode = adminModeProp ?? storeAdminMode;
  const [status, setStatus] = useState<"loading" | "error" | "done">("loading");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [split, setSplit] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cur = await getVersionRows(fileId, rec.v, adminMode);
        if (cancelled) return;
        if (!cur.ok) {
          setStatus("error");
          return;
        }
        if (prev) {
          const old = await getVersionRows(fileId, prev.v, adminMode);
          if (cancelled) return;
          const d = vComputeDiff(old.ok ? old.rows : [], cur.rows, columns);
          setDiff({
            ...d,
            oldLen: old.ok ? old.rows.length : 0,
            newLen: cur.rows.length,
          });
        } else {
          const d = vComputeDiff([], cur.rows, columns);
          setDiff({ ...d, oldLen: 0, newLen: cur.rows.length });
        }
        setStatus("done");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, rec.v, prev?.v, adminMode]);

  const render = useMemo(() => {
    if (!diff) return null;
    let o = 1;
    let n = 1;
    const nums = diff.lines.map((ln) => {
      const on = ln.type === "del" || ln.type === "ctx" ? o++ : 0;
      const nn = ln.type === "add" || ln.type === "ctx" ? n++ : 0;
      return { on, nn };
    });
    const oldTotal = o - 1;
    const newTotal = n - 1;
    const qq = q.trim().toLowerCase();
    const idxs = diff.lines
      .map((_, i) => i)
      .filter((i) => (qq ? diff.lines[i].text.toLowerCase().includes(qq) : true));
    const hunk =
      oldTotal === 0
        ? "@@ -0,0 +1," + newTotal + " @@"
        : "@@ -1," + oldTotal + " +1," + newTotal + " @@";
    return { nums, idxs, qq, hunk };
  }, [diff, q]);

  if (status === "loading") {
    return <div className="ghdiff-loading">Loading diff…</div>;
  }
  if (status === "error" || !diff || !render) {
    return <div className="ghdiff-loading">Error loading diff</div>;
  }

  const addPct = diff.add + diff.del > 0 ? diff.add / (diff.add + diff.del) : 0;
  const lit = Math.round(addPct * 5);
  const matched = render.idxs.length;

  return (
    <div className="ghdiff">
      <div className="ghdiff-summary">
        <span className="ghdiff-files">1 file changed</span>
        <span className="ghdiff-sum-stats">
          <span className="ghdiff-sum-add">+{diff.add}</span>
          <span className="ghdiff-sum-del">−{diff.del}</span>
          <span className="ghdiff-dots">
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} className={i < lit ? "on" : ""} />
            ))}
          </span>
        </span>
      </div>

      <div className="ghdiff-toolbar">
        <button
          className="ghdiff-icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          title={collapsed ? "Expand file" : "Collapse file"}
        >
          {collapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
        </button>
        <div className="ghdiff-search">
          <Search size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search within code"
            aria-label="Search within code"
          />
          {q ? (
            <button
              className="ghdiff-search-clear"
              onClick={() => setQ("")}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          ) : null}
          {q ? (
            <span className="ghdiff-search-count">
              {matched} of {diff.lines.length}
            </span>
          ) : null}
        </div>
        <button
          className="ghdiff-icon-btn"
          onClick={() => setSplit((s) => !s)}
          aria-label={split ? "Show unified view" : "Show split view"}
          title={split ? "Show unified view" : "Show split view"}
        >
          <Settings size={16} />
        </button>
      </div>

      <div className={"ghdiff-card" + (collapsed ? " collapsed" : "")}>
        <div className="ghdiff-card-head">
          <button
            className="ghdiff-chevron"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand file" : "Collapse file"}
          >
            <ChevronDown size={14} />
          </button>
          <span className="ghdiff-fname">{fileName}.xlsx</span>
          <span className="ghdiff-tag">{typeName}</span>
          <span className="ghdiff-file-stats">
            <span className="ghdiff-add">+{diff.add}</span>
            <span className="ghdiff-del">−{diff.del}</span>
          </span>
        </div>
        {!collapsed ? (
          <div className="ghdiff-body">
            <div className="ghdiff-hunk">
              <ChevronUp size={14} className="ghdiff-hunk-ico" />
              <span className="ghdiff-hunk-text">{render.hunk}</span>
            </div>
            {matched === 0 ? (
              <div className="ghdiff-empty">No matches for “{q}”</div>
            ) : split ? (
              <SplitRows
                lines={diff.lines}
                nums={render.nums}
                idxs={render.idxs}
                q={render.qq}
              />
            ) : (
              <UnifiedRows
                lines={diff.lines}
                nums={render.nums}
                idxs={render.idxs}
                q={render.qq}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

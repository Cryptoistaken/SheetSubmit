import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { parseStyles, useSheetStore } from "@/stores/sheetStore";
import { vibrate } from "@/lib/utils";
import type { ColumnDef, CrossDupEntry } from "@/lib/types";
import { Check, Phone, TriangleAlert } from "lucide-react";

interface ApiCall {
  type?: string;
  request?: string;
  response?: unknown;
}

interface ApiLog {
  status?: string;
  calls?: ApiCall[];
}

interface LogPopupState {
  logs: unknown[];
  label: string;
  crossInfo: CrossDupEntry[];
  wa: { status: string; banReason?: string | null; pageName?: string | null; linkedNumber?: string | null } | null;
  taken?: { at: number; pool?: string } | null;
  x: number;
  y: number;
}

export default function SheetGrid() {
  const rows = useSheetStore((s) => s.rows);
  const columns = useSheetStore((s) => s.columns);
  const visibleCols = useSheetStore((s) => s.visibleCols);
  const selectionMode = useSheetStore((s) => s.selectionMode);
  const selCols = useSheetStore((s) => s.selCols);

  const displayCols = useMemo(
    () => columns.filter((c) => visibleCols.has(c.key)),
    [columns, visibleCols],
  );

  const [logPopup, setLogPopup] = useState<LogPopupState | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActive = useRef(false);
  const clickCount = useRef(0);
  const clickTarget = useRef<Element | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ row: number; col: string; t: number } | null>(null);
  const dragStart = useRef<{ row: number; col: string } | null>(null);
  const dragActive = useRef(false);
  const dragMoved = useRef(false);
  const dragAdditive = useRef(false);
  const suppressClick = useRef(false);

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!logPopup) return;
    const onDoc = (ev: MouseEvent) => {
      const node = popupRef.current;
      if (node && !node.contains(ev.target as Node)) setLogPopup(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [logPopup]);

  function cancelHold() {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function endDrag() {
    dragActive.current = false;
    dragStart.current = null;
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragActive.current || !dragStart.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const td = el?.closest("td.dc") as HTMLElement | null;
    if (!td) return;
    const rowIdx = Number(td.dataset.row);
    const colKey = td.dataset.col ?? "";
    const start = dragStart.current;
    if (start.row !== rowIdx || start.col !== colKey) {
      dragMoved.current = true;
      useSheetStore
        .getState()
        .selectRange(start.row, start.col, rowIdx, colKey, dragAdditive.current);
    }
  }

  function handlePointerUp() {
    cancelHold();
    if (dragActive.current) {
      suppressClick.current = dragMoved.current;
      endDrag();
    }
  }

  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (holdActive.current) {
      holdActive.current = false;
      return;
    }
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const isBubble =
      typeof document !== "undefined" &&
      document.body.classList.contains("bubble-mode");
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const td = t.closest("td.dc") as HTMLElement | null;
    const dot = t.closest(".dot-cell") as HTMLElement | null;
    const rh = t.closest("th.rh") as HTMLElement | null;
    const ch = t.closest("th.ch:not(.corner):not(.ch-dot)") as HTMLElement | null;
    const corner = t.closest("th.corner") as HTMLElement | null;

    if (corner) {
      if (!isBubble) useSheetStore.getState().selectAllCells();
      return;
    }

    const el = rh || ch || dot || td;
    if (!el) return;
    if (el !== clickTarget.current) {
      clickCount.current = 0;
      clickTarget.current = el;
    }
    clickCount.current++;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (clickCount.current === 3) {
      clickCount.current = 0;
      clickTarget.current = null;
      if (rh) {
        void useSheetStore.getState().tripleTapRow(Number(rh.dataset.row));
        return;
      }
      if (ch) {
        void useSheetStore.getState().tripleTapCol(ch.dataset.col ?? "");
        return;
      }
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickCount.current = 0;
      clickTarget.current = null;
    }, 400);

    const store = useSheetStore.getState();
    if (rh) {
      if (!isBubble) store.toggleSelection("row", Number(rh.dataset.row), null);
      return;
    }
    if (dot) {
      void store.onDotDoubleTap(Number(dot.dataset.row));
      return;
    }
    if (ch) {
      if (!isBubble) store.toggleSelection("col", 0, ch.dataset.col ?? "");
      return;
    }
    if (td) {
      const rowIdx = Number(td.dataset.row);
      const colKey = td.dataset.col ?? "";
      const row = useSheetStore.getState().rows[rowIdx] as Record<string, unknown> | undefined;
      if (row && (row as Record<string, unknown>)._taken) return;
      if (useSheetStore.getState().isDesktop) {
        if (e.ctrlKey || e.metaKey) {
          useSheetStore.getState().toggleSelection("cell", rowIdx, colKey);
          return;
        }
        if (store.selectionMode) {
          store.selectCellOnly(rowIdx, colKey);
          return;
        }
        if (
          store.qebOpen &&
          store.selectedCell &&
          (store.selectedCell.rowIdx !== rowIdx ||
            store.selectedCell.colIdx !== colKey)
        ) {
          store.commitQuickEdit();
        }
        store.openInlineEdit(rowIdx, colKey);
        return;
      }
      if (store.selectionMode) {
        store.toggleSelection("cell", rowIdx, colKey);
        return;
      }
      const now = Date.now();
      const last = lastTap.current;
      if (
        last &&
        last.row === rowIdx &&
        last.col === colKey &&
        now - last.t < 400
      ) {
        lastTap.current = null;
        useSheetStore.getState().selectCellOnly(rowIdx, colKey);
        void useSheetStore.getState().doubleTap(rowIdx, colKey);
        return;
      }
      lastTap.current = { row: rowIdx, col: colKey, t: now };
      if (
        store.qebOpen &&
        store.selectedCell &&
        (store.selectedCell.rowIdx !== rowIdx ||
          store.selectedCell.colIdx !== colKey)
      ) {
        store.commitQuickEdit();
      }
      store.openQuickEdit(rowIdx, colKey);
    }
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    holdActive.current = false;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const store = useSheetStore.getState();
    const isBubble =
      typeof document !== "undefined" &&
      document.body.classList.contains("bubble-mode");

    const td = t.closest("td.dc") as HTMLElement | null;
    if (store.isDesktop) {
      if (td) {
        dragStart.current = {
          row: Number(td.dataset.row),
          col: td.dataset.col ?? "",
        };
        dragActive.current = true;
        dragMoved.current = false;
        dragAdditive.current = !!(e.ctrlKey || e.metaKey);
      }
      const dot = t.closest(".dot-cell") as HTMLElement | null;
      if (dot) {
        const rowIdx = Number(dot.dataset.row);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          holdActive.current = true;
          const result = useSheetStore.getState().onDotHold(rowIdx);
          const row = useSheetStore.getState().rows[rowIdx] as Record<string, unknown> | undefined;
          const taken = row && (row as Record<string, unknown>)._taken ? { at: (row as Record<string, unknown>)._takenAt as number, pool: (row as Record<string, unknown>)._pool as string | undefined } : null;
          if (result || taken) {
            const rect = dot.getBoundingClientRect();
            setLogPopup({
              logs: result?.logs ?? [],
              label: result?.label ?? String(rowIdx + 1),
              crossInfo: result?.crossInfo ?? [],
              wa: result?.wa ?? null,
              taken,
              x: Math.max(4, rect.right - 340),
              y: rect.bottom + 4,
            });
          }
        }, 500);
      }
      return;
    }

    if (td && !store.selectionMode && !isBubble) {
      const rowIdx = Number(td.dataset.row);
      const colKey = td.dataset.col ?? "";
      const row = useSheetStore.getState().rows[rowIdx] as Record<string, unknown> | undefined;
      if (row && (row as Record<string, unknown>)._taken) return;
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        holdActive.current = true;
        vibrate(15);
        useSheetStore.getState().enterSelectionMode("cell", rowIdx, colKey);
      }, 500);
      return;
    }

    const dot = t.closest(".dot-cell") as HTMLElement | null;
    if (dot) {
      const rowIdx = Number(dot.dataset.row);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        holdActive.current = true;
        vibrate(15);
        const result = useSheetStore.getState().onDotHold(rowIdx);
        const row = useSheetStore.getState().rows[rowIdx] as Record<string, unknown> | undefined;
        const taken = row && (row as Record<string, unknown>)._taken ? { at: (row as Record<string, unknown>)._takenAt as number, pool: (row as Record<string, unknown>)._pool as string | undefined } : null;
        if (result || taken) {
          const rect = dot.getBoundingClientRect();
          setLogPopup({
            logs: result?.logs ?? [],
            label: result?.label ?? String(rowIdx + 1),
            crossInfo: result?.crossInfo ?? [],
            wa: result?.wa ?? null,
            taken,
            x: Math.max(4, rect.right - 340),
            y: rect.bottom + 4,
          });
        }
      }, 500);
      return;
    }

    const ch = t.closest("th.ch:not(.corner):not(.ch-dot)") as HTMLElement | null;
    if (ch && !store.selectionMode && !isBubble) {
      const colKey = ch.dataset.col ?? "";
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        holdActive.current = true;
        vibrate(15);
        useSheetStore.getState().enterSelectionMode("col", 0, colKey);
      }, 500);
      return;
    }

    const rh = t.closest("th.rh") as HTMLElement | null;
    if (rh && !store.selectionMode && !isBubble) {
      const rowIdx = Number(rh.dataset.row);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        holdActive.current = true;
        vibrate(15);
        useSheetStore.getState().enterSelectionMode("row", rowIdx, null);
      }, 500);
    }
  }

  return (
    <div
      className="sheet-wrap"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onScroll={() => setLogPopup(null)}
    >
      <table className="grid" role="grid" cellSpacing={0} cellPadding={0}>
        <thead role="rowgroup">
          <tr role="row">
            <th className="corner"></th>
            {displayCols.map((col, i) => (
              <th
                key={col.key}
                className={"ch" + (selectionMode && selCols.has(col.key) ? " col-sel" : "")}
                data-col={col.key}
                role="columnheader"
                aria-colindex={i + 1}
              >
                {col.label}
              </th>
            ))}
            <th className="ch-dot"></th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((_, i) => (
            <GridRow key={i} rowIdx={i} displayCols={displayCols} />
          ))}
          <tr className="add-row" role="row">
            <td
              className="rh-add"
              colSpan={displayCols.length + 2}
              role="button"
              tabIndex={0}
              onClick={() => useSheetStore.getState().addRow()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  useSheetStore.getState().addRow();
                }
              }}
            >
              + Add row
            </td>
          </tr>
        </tbody>
      </table>

      {logPopup && (
        <div
          ref={popupRef}
          className="file-ctx-popup open"
          style={{
            left: logPopup.x,
            top: logPopup.y,
            width: 340,
            maxHeight: "50vh",
            overflowY: "auto",
            padding: 10,
          }}
        >
          {logPopup.taken ? (
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--blue)", marginBottom: 6, padding: "6px 8px", background: "var(--blue-light)", borderRadius: 6 }}>
              Taken ✓ — claimed{logPopup.taken.pool ? ` from ${logPopup.taken.pool}` : ""}{logPopup.taken.at ? ` on ${new Date(logPopup.taken.at).toLocaleDateString()}` : ""} • permanently blocked
            </div>
          ) : null}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {logPopup.label} — {logPopup.logs.length} API call
            {logPopup.logs.length > 1 ? "s" : ""}
          </div>
          {logPopup.crossInfo.length > 0 ? (
            <div
              style={{
                padding: "6px 0",
                borderBottom: "1px solid var(--border2)",
                marginBottom: 4,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--yellow)",
                  marginBottom: 4,
                }}
              >
                ⚠ Cross-file duplicate
              </div>
              {logPopup.crossInfo.map((e, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "var(--text2)",
                    padding: "2px 0",
                  }}
                >
                  {e.fileName} (row {e.rowIdx + 1})
                </div>
              ))}
            </div>
          ) : null}
          {logPopup.wa ? (
            <>
              {logPopup.wa.status === "eligible" ? (
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--green)",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Check size={12} strokeWidth={3} style={{ flexShrink: 0 }} />
                  <span>FB Page{logPopup.wa.pageName ? ` — ${logPopup.wa.pageName}` : ""}</span>
                </div>
              ) : logPopup.wa.banReason ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text3)",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <TriangleAlert size={12} style={{ flexShrink: 0 }} />
                  <span>{logPopup.wa.banReason}</span>
                </div>
              ) : null}
              {logPopup.wa.linkedNumber ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text2)",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Phone size={12} style={{ flexShrink: 0 }} />
                  <span>{logPopup.wa.linkedNumber}</span>
                </div>
              ) : null}
            </>
          ) : null}
          {logPopup.logs.length === 0 ? (
            <div style={{ padding: "6px 0", color: "var(--text3)", fontSize: 12 }}>
              No logs for this row
            </div>
          ) : (
            logPopup.logs.map((log, idx) => {
              const l = log as ApiLog;
              const statusIcon = l.status === "done" ? "✓" : "✗";
              const statusColor = l.status === "done" ? "var(--green)" : "var(--red)";
              return (
                <div
                  key={idx}
                  style={{
                    padding: "6px 0",
                    borderTop: idx ? "1px solid var(--border)" : "none",
                    fontSize: 12,
                  }}
                >
                  {(l.calls ?? []).map((call, ci) => {
                    if (call.type === "error") {
                      return (
                        <div
                          key={ci}
                          style={{ color: "var(--red)", padding: "2px 0", fontSize: 12 }}
                        >
                          ⚠ {String(call.response)}
                        </div>
                      );
                    }
                    let pretty: string;
                    try {
                      pretty = JSON.stringify(JSON.parse(String(call.response)), null, 2);
                    } catch {
                      pretty = String(call.response);
                    }
                    return (
                      <div key={ci}>
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ color: statusColor, fontWeight: 600 }}>
                            {statusIcon} {call.type?.toUpperCase()}
                          </span>
                        </div>
                        <div
                          style={{ color: "var(--text3)", fontSize: 11, marginBottom: 1 }}
                        >
                          {call.request}
                        </div>
                        <pre
                          style={{
                            margin: "2px 0 0",
                            fontSize: 11,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-all",
                            color: "var(--text)",
                            fontFamily: "var(--mono)",
                            background: "var(--bg3)",
                            padding: "4px 6px",
                            borderRadius: 4,
                            lineHeight: 1.4,
                          }}
                        >
                          {pretty}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const GridRow = memo(function GridRow({
  rowIdx,
  displayCols,
}: {
  rowIdx: number;
  displayCols: ColumnDef[];
}) {
  const row = useSheetStore((s) => s.rows[rowIdx]);
  const isRowSel = useSheetStore((s) => s.selRows.has(rowIdx));
  const isDupRow = useSheetStore(
    (s) => s.dupRows.has(rowIdx) || s.crossDupRows.has(rowIdx),
  );

  const taken = !!(row as Record<string, unknown>)?._taken;
  const status = row?.status ?? "";
  const dotClass = taken
    ? "d-taken"
    : isDupRow
      ? "d-yellow"
      : status === "bad"
        ? "d-red"
        : row?.wa_status === "eligible"
          ? "d-green"
          : status === "good" || status === "done"
            ? "d-blue"
            : status === "pending"
              ? "d-spin d-yellow"
              : "";
  const statusLabel = taken
    ? "Taken — claimed"
    : isDupRow
      ? "Duplicate row"
      : status === "bad"
        ? "Dead account"
        : row?.wa_status === "eligible"
          ? "FB page eligible"
          : status === "good" || status === "done"
            ? "Valid account"
            : status === "pending"
              ? "Checking…"
              : "";

  return (
    <tr className={`${isRowSel ? "row-selected" : ""}${taken ? " row-taken" : ""}`} role="row">
      <th
        className={"rh" + (isRowSel ? " row-sel" : "")}
        data-row={rowIdx}
        role="rowheader"
      >
        {rowIdx + 1}
      </th>
      {displayCols.map((col, i) => (
        <GridCell key={col.key} rowIdx={rowIdx} colKey={col.key} colIndex={i} />
      ))}
      <td
        className="dot-cell"
        data-row={rowIdx}
        title={statusLabel || undefined}
        aria-label={statusLabel || undefined}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <span className={"row-dot" + (dotClass ? " " + dotClass : "")}></span>
        </div>
      </td>
    </tr>
  );
});

const GridCell = memo(function GridCell({
  rowIdx,
  colKey,
  colIndex,
}: {
  rowIdx: number;
  colKey: string;
  colIndex: number;
}) {
  const row = useSheetStore((s) => s.rows[rowIdx]);
  const value = (row?.[colKey] ?? "") as string;
  const sel = useSheetStore((s) => s.selectedItems.has(rowIdx + ":" + colKey));
  const dup = useSheetStore((s) => s.dupCells.has(rowIdx + ":" + colKey));
  const invalid = useSheetStore((s) => s.invalidCells.has(rowIdx + ":" + colKey));
  const active = useSheetStore(
    (s) =>
      s.selectedCell?.rowIdx === rowIdx &&
      s.selectedCell.colIdx === colKey,
  );
  const inlineActive = useSheetStore(
    (s) =>
      s.inlineEdit &&
      s.selectedCell?.rowIdx === rowIdx &&
      s.selectedCell.colIdx === colKey,
  );
  const draft = useSheetStore((s) =>
    (s.qebOpen || s.inlineEdit) &&
    s.selectedCell?.rowIdx === rowIdx &&
    s.selectedCell.colIdx === colKey
      ? s.draft
      : null,
  );
  const styles = parseStyles(row ?? ({} as never))[colKey];

  const taken = !!(row as Record<string, unknown>)?._taken;
  return (
    <td
      className={
        "dc" +
        (sel ? " ms-sel" : "") +
        (dup ? " cell-dup" : "") +
        (invalid ? " cell-invalid" : "") +
        (active ? " cell-editing" : "") +
        (taken ? " cell-taken" : "")
      }
      data-row={rowIdx}
      data-col={colKey}
      role="gridcell"
      aria-colindex={colIndex + 1}
      tabIndex={taken ? -1 : active ? 0 : -1}
      aria-label={value + (dup ? " (duplicate)" : "")}
      style={{
        backgroundColor: taken ? "#0070f3" : styles?.bg || undefined,
        color: taken ? (active ? "#fff" : "rgba(255,255,255,0.72)") : styles?.color || undefined,
        fontWeight: styles?.bold ? 700 : undefined,
        pointerEvents: taken ? "none" as const : undefined,
      }}
    >
      <div className="cell-inner">
        {inlineActive ? (
          <InlineEditInput />
        ) : (
          <span
            className="cell-text"
            style={{
              color: styles?.color || undefined,
              fontWeight: styles?.bold ? 700 : undefined,
            }}
          >
            {draft ?? value}
          </span>
        )}
      </div>
    </td>
  );
});

const InlineEditInput = memo(function InlineEditInput() {
  const draft = useSheetStore((s) => s.draft);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const store = useSheetStore.getState();
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        store.moveEdit(1, 0);
        break;
      case "Tab":
        e.preventDefault();
        store.moveEdit(0, e.shiftKey ? -1 : 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        store.moveEdit(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        store.moveEdit(-1, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        store.moveEdit(0, 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        store.moveEdit(0, -1);
        break;
      case "Escape":
        e.preventDefault();
        store.cancelQuickEdit();
        break;
    }
  };

  return (
    <input
      ref={inputRef}
      className="cell-edit-input"
      type="text"
      aria-label="Cell value"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={draft}
      onChange={(e) => useSheetStore.getState().setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => {
        const store = useSheetStore.getState();
        if (store.inlineEdit) store.commitQuickEdit();
      }}
    />
  );
});

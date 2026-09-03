import { useModalA11y } from "@/hooks/useModalA11y";
import { useSheetStore } from "@/stores/sheetStore";
import { useConfirm } from "@/lib/confirm";
import type { Row } from "@/lib/types";

export default function UploadOverlay({
  rows,
  onClose,
}: {
  rows: Row[] | null;
  onClose: () => void;
}) {
  const applyUpload = useSheetStore((s) => s.applyUpload);
  const columns = useSheetStore((s) => s.columns);
  const currentCount = useSheetStore(
    (s) => s.rows.filter((r) => columns.some((c) => r[c.key])).length,
  );
  const confirm = useConfirm();
  const modalRef = useModalA11y(!!rows, onClose);

  if (!rows) return null;
  const n = rows.length;

  return (
    <div
      ref={modalRef}
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-label="Upload xlsx"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-title">Upload xlsx</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text2)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          How do you want to apply the uploaded data?
        </div>
        <button
          className="btn"
          style={{ width: "100%", justifyContent: "flex-start", marginBottom: 8 }}
          onClick={async () => {
            const ok = await confirm(
              "Replace ALL " +
                n +
                " rows? Your file currently holds " +
                currentCount +
                " rows. Existing data will be **permanently replaced**. Continue?",
              "Yes, replace",
            );
            if (!ok) return;
            applyUpload("replace", rows);
            onClose();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Replace all data
        </button>
        <button
          className="btn"
          style={{ width: "100%", justifyContent: "flex-start", marginBottom: 8 }}
          onClick={() => {
            applyUpload("append", rows);
            onClose();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Append rows
        </button>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

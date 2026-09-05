import { cn } from "@/lib/utils";

const FILE_SKELETON_COUNT = 10;

type PageSkeletonProps = {
  variant?: "files" | "archive" | "pools" | "admin" | "admin-detail" | "tools" | "splitter" | "sheet";
  className?: string;
};

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div style={style} className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

function FileCardSkeleton({ withDaysLeft }: { withDaysLeft?: boolean }) {
  return (
    <div className="file-card" aria-hidden="true" style={{ minHeight: 110, pointerEvents: "none" }}>
      <div className="file-card-icon" style={{ background: "var(--bg3)" }}>
        <Skeleton className="h-4 w-4 rounded-sm" />
      </div>
      <Skeleton className="h-[13px] w-[68%] rounded" />
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Skeleton className="h-[18px] w-[46px] rounded" />
        <Skeleton className="h-[18px] w-[52px] rounded" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Skeleton className="h-3 w-14 rounded" />
        <Skeleton className="h-3 w-8 rounded" />
        <Skeleton className="h-3 w-8 rounded" />
      </div>
      <Skeleton className="absolute h-6 w-6 rounded" style={{ top: 7, right: 7 }} />
      {withDaysLeft ? <Skeleton className="absolute h-2.5 w-12 rounded" style={{ bottom: 5, right: 8 }} /> : null}
    </div>
  );
}

function PoolCardSkeleton() {
  return (
    <div className="pool-card" aria-hidden="true" style={{ pointerEvents: "none" }}>
      <Skeleton className="h-3.5 w-3.5 rounded-sm shrink-0" />
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="pool-card-info">
        <Skeleton className="h-3.5 w-[46%] max-w-[140px] rounded" />
        <Skeleton className="h-3 w-[32%] max-w-[100px] rounded" />
      </div>
      <div className="pool-card-stats">
        <Skeleton className="h-3 w-7 rounded" />
        <Skeleton className="h-3 w-3 rounded" />
        <Skeleton className="h-3 w-7 rounded" />
      </div>
      <Skeleton className="h-8 w-8 rounded-md shrink-0" />
    </div>
  );
}

function DlCardSkeleton() {
  return (
    <div className="pool-card dl-card" aria-hidden="true" style={{ pointerEvents: "none" }}>
      <Skeleton className="h-5 w-16 rounded-full shrink-0" />
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="pool-card-info">
        <Skeleton className="h-3.5 w-[60%] max-w-[180px] rounded" />
        <Skeleton className="h-3 w-[48%] max-w-[140px] rounded" />
      </div>
      <div className="pool-card-actions" style={{ display: "flex", gap: 6 }}>
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="h-7 w-14 rounded-md" />
      </div>
    </div>
  );
}

function AdminRowSkeleton() {
  return (
    <div className="admin-user-card" aria-hidden="true" style={{ pointerEvents: "none" }}>
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="admin-user-info" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className="h-3 w-20 rounded" />
      </div>
      <div className="admin-user-meta" style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
        <Skeleton className="h-3 w-12 rounded" />
        <Skeleton className="h-3 w-16 rounded" />
      </div>
    </div>
  );
}

function Wrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="status" aria-label="Loading page" aria-busy="true" className={cn(className)}>
      {children}
    </div>
  );
}

export default function PageSkeleton({ variant = "files", className }: PageSkeletonProps) {
  if (variant === "files" || variant === "archive") {
    return (
      <Wrap className={cn("w-full", className)}>
        <div className="files-grid">
          {Array.from({ length: FILE_SKELETON_COUNT }, (_, i) => (
            <FileCardSkeleton key={i} withDaysLeft={variant === "archive"} />
          ))}
        </div>
      </Wrap>
    );
  }

  if (variant === "pools") {
    return (
      <Wrap className={cn("flex w-full flex-col gap-0", className)}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <Skeleton className="h-[18px] w-14 rounded" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className="pool-switch" style={{ pointerEvents: "none" }}>
              <Skeleton className="h-7 w-24 rounded-md" />
              <Skeleton className="h-7 w-24 rounded-md" />
            </div>
            <div className="pool-switch" style={{ pointerEvents: "none" }}>
              <Skeleton className="h-7 w-16 rounded-md" />
              <Skeleton className="h-7 w-14 rounded-md" />
              <Skeleton className="h-7 w-14 rounded-md" />
            </div>
          </div>
        </div>

        <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-hidden="true">
              <Skeleton className="h-2.5 w-20 rounded" />
              <Skeleton className="h-6 w-16 rounded mt-3" />
              <Skeleton className="h-3 w-20 rounded mt-3" />
            </div>
          ))}
        </div>

        <div className="pools-toolbar pools-stack" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-[180px] rounded-md" />
            <Skeleton className="h-9 w-44 rounded-md" />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, marginBottom: 8 }}>
          <Skeleton className="h-9 w-60 rounded-md" />
        </div>

        <div className="card-list" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <PoolCardSkeleton key={i} />
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <Skeleton className="h-3.5 w-32 rounded mb-2" />
          <div className="card-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: 3 }, (_, i) => (
              <DlCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </Wrap>
    );
  }

  if (variant === "admin") {
    return (
      <Wrap className={cn("flex w-full flex-col", className)}>
        <div className="admin-stats">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="admin-stat-card" aria-hidden="true">
              <Skeleton className="h-7 w-12 rounded" />
              <Skeleton className="h-3 w-20 rounded mt-2" />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <Skeleton className="h-4 w-16 rounded" />
          <Skeleton className="h-9 w-60 rounded-md" />
        </div>
        <div className="admin-user-list">
          {Array.from({ length: 5 }, (_, i) => (
            <AdminRowSkeleton key={i} />
          ))}
        </div>
      </Wrap>
    );
  }

  if (variant === "admin-detail") {
    return (
      <Wrap className={cn("flex w-full flex-col", className)}>
        <Skeleton className="h-8 w-32 rounded-md mb-4" />
        <div className="admin-detail-header" style={{ pointerEvents: "none" }} aria-hidden="true">
          <Skeleton className="h-12 w-12 rounded-full shrink-0" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <div className="pool-switch" style={{ pointerEvents: "none" }}>
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="h-7 w-20 rounded-md" />
          </div>
        </div>
        <div className="files-grid">
          {Array.from({ length: FILE_SKELETON_COUNT }, (_, i) => (
            <FileCardSkeleton key={i} />
          ))}
        </div>
      </Wrap>
    );
  }

  if (variant === "tools") {
    return (
      <Wrap className={cn("w-full", className)}>
        <Skeleton className="h-5 w-14 rounded" style={{ marginBottom: 4 }} />
        <Skeleton className="h-3 w-28 rounded" style={{ marginBottom: 16 }} />
        <div className="files-grid">
          <div className="file-card" aria-hidden="true" style={{ minHeight: 110, pointerEvents: "none" }}>
            <div className="file-card-icon" style={{ background: "var(--bg3)" }}>
              <Skeleton className="h-4 w-4 rounded-sm" />
            </div>
            <Skeleton className="h-[13px] w-16 rounded" />
            <Skeleton className="h-3 w-28 rounded" />
            <Skeleton className="h-[18px] w-12 rounded" />
          </div>
        </div>
      </Wrap>
    );
  }

  if (variant === "splitter") {
    return (
      <Wrap className={cn("w-full", className)}>
        <Skeleton className="h-7 w-20 rounded-md" style={{ marginBottom: 16 }} />
        <Skeleton className="h-4 w-16 rounded" style={{ marginBottom: 2 }} />
        <Skeleton className="h-3 w-48 rounded" style={{ marginBottom: 16 }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" style={{ marginBottom: 12 }} />
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 16, background: "var(--bg)" }} aria-hidden="true">
          <Skeleton className="h-3 w-16 rounded mb-3" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <Skeleton className="h-10 w-20 rounded-md" />
            <Skeleton className="h-10 w-20 rounded-md" />
            <Skeleton className="h-10 w-20 rounded-md" />
            <Skeleton className="h-10 w-24 rounded-md" />
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-7 flex-1 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-3 w-64 rounded mt-2" />
        </div>
      </Wrap>
    );
  }

  if (variant === "sheet") {
    return (
      <Wrap className={cn("flex min-h-0 w-full flex-col bg-background", className)}>
        <div style={{ height: 40, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", flexShrink: 0 }} aria-hidden="true">
          <Skeleton className="h-6 w-28 rounded" />
          <Skeleton className="h-6 w-20 rounded" />
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <Skeleton className="h-7 w-16 rounded-md" />
            <Skeleton className="h-7 w-16 rounded-md" />
            <Skeleton className="h-7 w-20 rounded-md" />
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          <div style={{ minWidth: 640 }}>
            <table className="grid" aria-hidden="true" cellSpacing={0} cellPadding={0} style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th className="corner" style={{ width: 36, minWidth: 36, height: 36, background: "var(--bg2)", border: "1px solid var(--border)" }}>
                    <Skeleton className="h-3 w-3 mx-auto rounded-sm" />
                  </th>
                  {Array.from({ length: 4 }, (_, i) => (
                    <th key={i} className="ch" style={{ background: "var(--bg2)", border: "1px solid var(--border)", height: 36 }}>
                      <Skeleton className="h-3 w-14 mx-auto rounded" />
                    </th>
                  ))}
                  <th className="ch-dot" style={{ width: 36, minWidth: 36, background: "var(--bg2)", border: "1px solid var(--border)", height: 36 }}>
                    <Skeleton className="h-2 w-2 mx-auto rounded-full" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 24 }, (_, r) => (
                  <tr key={r}>
                    <th className="rh" style={{ width: 36, minWidth: 36, height: 36, background: "var(--bg2)", border: "1px solid var(--border)", textAlign: "center" }}>
                      <Skeleton className="h-3 w-4 mx-auto rounded" />
                    </th>
                    {Array.from({ length: 4 }, (_, c) => (
                      <td key={c} className="dc" style={{ height: 36, border: "1px solid var(--border)", background: "var(--bg)", padding: "0 8px", verticalAlign: "middle" }}>
                        <Skeleton className={cn("h-3 rounded", c === 0 ? "w-[70%]" : c === 1 ? "w-[55%]" : c === 2 ? "w-[60%]" : "w-[45%]")} />
                      </td>
                    ))}
                    <td className="dot-cell" style={{ width: 36, minWidth: 36, height: 36, border: "1px solid var(--border)", background: "var(--bg)", textAlign: "center", verticalAlign: "middle" }}>
                      <Skeleton className="h-2 w-2 mx-auto rounded-full" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Wrap>
    );
  }

  // Detailed-only fallback (no generic): default to files shape.
  return (
    <Wrap className={cn("w-full", className)}>
      <div className="files-grid">
        {Array.from({ length: FILE_SKELETON_COUNT }, (_, i) => (
          <FileCardSkeleton key={i} />
        ))}
      </div>
    </Wrap>
  );
}

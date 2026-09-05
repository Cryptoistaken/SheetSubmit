interface EmptyStateProps {
  title: string;
  sub: string;
  action?: { label: string; onClick: () => void };
}

export default function EmptyState({ title, sub, action }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-sub">{sub}</div>
      {action ? (
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

import { cn } from "@/lib/utils";

type PageSkeletonProps = {
  variant?: "grid" | "list" | "sheet";
  className?: string;
};

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export default function PageSkeleton({ variant = "grid", className }: PageSkeletonProps) {
  if (variant === "sheet") {
    return (
      <div role="status" aria-label="Loading page" aria-busy="true" className={cn("flex min-h-full flex-col gap-3 bg-background p-4", className)}>
        <Skeleton className="h-10 w-full" />
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 18 }, (_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      </div>
    );
  }

  return (
    <div role="status" aria-label="Loading page" aria-busy="true" className={cn("flex flex-col gap-4 p-6", className)}>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-9 w-24" />
      </div>
      {variant === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      )}
    </div>
  );
}

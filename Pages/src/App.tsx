import { lazy, Suspense, useMemo } from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useParams,
} from "react-router";

import LoginScreen from "@/components/auth/LoginScreen";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";

import Topbar from "@/components/layout/Topbar";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/lib/theme";
import HomePage from "@/pages/HomePage";
import SheetPage from "@/pages/SheetPage";

const BubbleMode = lazy(() => import("@/components/bubble/BubbleMode"));
const BubbleDesignPage = lazy(() => import("@/pages/BubbleDesignPage"));

function getBubbleFileId(): string | null {
  try {
    const qs = new URLSearchParams(window.location.search);
    const isAndroid =
      !!(window as unknown as { Android?: unknown }).Android;
    const file = qs.get("file");
    if (qs.get("bubble") === "1" && file && isAndroid) return file;
  } catch {
    // ignore malformed query
  }
  return null;
}

type DetailedSkeletonVariant = "files" | "archive" | "pools" | "admin" | "admin-detail" | "tools" | "splitter" | "sheet";

function skeletonForPath(pathname: string): DetailedSkeletonVariant {
  if (pathname.includes("/file/")) return "sheet";
  if (pathname.startsWith("/archive")) return "archive";
  if (pathname.startsWith("/pools")) return "pools";
  if (pathname.startsWith("/admin/user/")) return "admin-detail";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname === "/tools" || pathname === "/tools/") return "tools";
  if (pathname === "/tools/splitter" || pathname === "/tools/splitter/") return "splitter";
  if (pathname.startsWith("/bubble-design")) return "splitter";
  return "files";
}

function LoadingShell({ variant }: { variant: DetailedSkeletonVariant }) {
  const sheet = variant === "sheet";
  const paneStyle = variant === "pools"
    ? { padding: "24px", maxWidth: 960 }
    : variant === "tools" || variant === "splitter"
      ? { padding: "32px 24px", maxWidth: 960 }
      : undefined;
  const paneId = variant === "pools"
    ? "homePanePools"
    : variant === "tools" || variant === "splitter"
      ? "homePaneTools"
      : variant === "archive"
        ? "homePaneArchive"
        : variant === "admin" || variant === "admin-detail"
          ? "homePaneAdmin"
          : "homePaneFiles";
  return (
    <div className="flex h-dvh flex-col">
      <header>
        <div className="topbar" aria-hidden="true">
          <div className="topbar-l">
            <Skeleton className="h-5 w-5 rounded-sm" />
            <Skeleton className="h-4 w-28 rounded" />
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </header>
      <main id="main-content" className="flex flex-1 min-h-0 flex-col">
        {!sheet ? (
          <div id="homeTabBar" aria-hidden="true">
            <div className="home-tabs">
              {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-9 w-24 rounded-md" />)}
            </div>
          </div>
        ) : null}
        <div
          id={!sheet ? paneId : undefined}
          className={!sheet ? "home-pane" : undefined}
          style={paneStyle ? { ...paneStyle, margin: "0 auto", width: "100%" } : undefined}
        >
          <PageSkeleton variant={variant} className="min-h-0" sheetToolbar={false} />
        </div>
      </main>
    </div>
  );
}

function Layout() {
  const { pathname } = useLocation();
  const variant = skeletonForPath(pathname);
  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[9999] focus:rounded-md focus:bg-[var(--bg)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--text)] focus:shadow-md focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
      >
        Skip to content
      </a>
      <header>
        <Topbar />
      </header>
      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col min-h-0 focus:outline-none">
        <Suspense fallback={<PageSkeleton variant={variant} className="min-h-0" sheetToolbar={variant !== "sheet"} />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

// Fallbacks for hand-typed bare admin URLs with a missing id segment — send the
// user back to the nearest real state instead of a blank screen.
function AdminFileFallback() {
  const { userId } = useParams();
  return <Navigate to={userId ? `/admin/user/${userId}` : "/admin"} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "files", element: <HomePage /> },
          { path: "archive", element: <HomePage /> },
          { path: "wallet", element: <HomePage /> },
          { path: "pools", element: <Navigate to="/pools/dgddigital/cookies_only" replace /> },
          { path: "pools/:password/:poolId", element: <HomePage /> },
          { path: "admin", element: <HomePage /> },
          { path: "tools", element: <HomePage /> },
          { path: "tools/splitter", element: <HomePage /> },
          { path: "admin/user", element: <Navigate to="/admin" replace /> },
          { path: "admin/user/:userId", element: <HomePage /> },
          { path: "admin/user/:userId/file", element: <AdminFileFallback /> },
          { path: "admin/user/:userId/file/:fileId", element: <SheetPage /> },
          { path: "file/:id", element: <SheetPage /> },
          { path: "bubble-design", element: <BubbleDesignPage /> },
        ],
      },
    ],
  },
  { path: "login", element: <LoginRoute /> },
]);

// Public sign-in page. Reads the redirect-back destination + expired flag from
// RequireAuth's navigation state; already-logged-in visitors bounce to the app.
function LoginRoute() {
  const { user, loading } = useAuth();
  const { state } = useLocation() as { state?: { from?: unknown; expired?: boolean } };
  const next = typeof state?.from === "string" && state.from.startsWith("/") && !state.from.startsWith("//")
    ? state.from
    : "/";
  if (loading) return <LoadingShell variant="files" />;
  if (user) return <Navigate to={next} replace />;
  return (
    <div className="flex h-dvh flex-col">
      <LoginScreen
        notice={state?.expired ? "Session expired. Please log in again." : undefined}
        next={next}
      />
    </div>
  );
}

// Gate for everything except /login: loading shell → bounce to /login carrying
// the original destination → Android bubble → the authed Layout tree.
function RequireAuth() {
  const { user, loading, sessionExpired } = useAuth();
  const location = useLocation();
  const bubbleFileId = useMemo(() => getBubbleFileId(), []);

  if (loading) {
    return bubbleFileId
      ? <PageSkeleton variant="sheet" className="min-h-dvh" sheetToolbar={false} />
      : <LoadingShell variant={skeletonForPath(location.pathname)} />;
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search, expired: sessionExpired }}
      />
    );
  }

  // Android floating-bubble mini window (?bubble=1&file=<id>) — code-split so the
  // main bundle stays lean; only loads inside the Android WebView.
  if (bubbleFileId) {
    return (
      <Suspense fallback={<PageSkeleton variant="sheet" className="min-h-dvh" sheetToolbar={false} />}>
        <BubbleMode fileId={bubbleFileId} />
      </Suspense>
    );
  }

  return <Outlet />;
}

export default function App() {
  // Apply the saved theme on first paint — the login screen has no theme toggle of its own.
  useTheme();
  return <RouterProvider router={router} />;
}

import { lazy, Suspense, useMemo } from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useParams,
} from "react-router";

import LoginScreen from "@/components/auth/LoginScreen";
import OfflineBanner from "@/components/layout/OfflineBanner";
import Topbar from "@/components/layout/Topbar";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/lib/theme";
import HomePage from "@/pages/HomePage";
import SheetPage from "@/pages/SheetPage";

const BubbleMode = lazy(() => import("@/components/bubble/BubbleMode"));
const VersionDiffPage = lazy(() => import("@/pages/VersionDiffPage"));
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

function Layout() {
  return (
    <>
      <div className="flex h-dvh flex-col">
        <Topbar />
        <Suspense fallback={<div className="flex h-dvh flex-col" />}>
          <Outlet />
        </Suspense>
      </div>
      <OfflineBanner />
    </>
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
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "files", element: <HomePage /> },
      { path: "archive", element: <HomePage /> },
      { path: "pools", element: <Navigate to="/pools/dgddigital/cookies_only" replace /> },
      { path: "pools/:password/:poolId", element: <HomePage /> },
      { path: "admin", element: <HomePage /> },
      { path: "tools", element: <HomePage /> },
      { path: "tools/splitter", element: <HomePage /> },
      { path: "admin/user", element: <Navigate to="/admin" replace /> },
      { path: "admin/user/:userId", element: <HomePage /> },
      { path: "admin/user/:userId/file", element: <AdminFileFallback /> },
      { path: "admin/user/:userId/file/:fileId", element: <SheetPage /> },
      { path: "admin/user/:userId/file/:fileId/version/:v", element: <VersionDiffPage /> },
      { path: "file/:id", element: <SheetPage /> },
      { path: "file/:id/version/:v", element: <VersionDiffPage /> },
      { path: "bubble-design", element: <BubbleDesignPage /> },
    ],
  },
]);

export default function App() {
  // Apply the saved theme on first paint — the login screen has no theme toggle of its own.
  useTheme();
  const { user, loading } = useAuth();
  const bubbleFileId = useMemo(() => getBubbleFileId(), []);

  if (loading) return <div className="flex h-dvh flex-col" />;

  // Android floating-bubble mini window (?bubble=1&file=<id>) — code-split so the
  // main bundle stays lean; only loads inside the Android WebView.
  if (user && bubbleFileId) {
    return (
      <Suspense fallback={<div className="flex h-dvh flex-col" />}>
        <BubbleMode fileId={bubbleFileId} />
      </Suspense>
    );
  }

  if (!user) {
    return (
      <div className="flex h-dvh flex-col">
        <LoginScreen />
      </div>
    );
  }
  return <RouterProvider router={router} />;
}

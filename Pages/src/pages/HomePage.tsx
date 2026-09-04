import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

// Stale chunk after a fresh deploy (old tab imports a hashed asset the new
// deploy deleted) — reload once to fetch the fresh index.html instead of
// crashing to "Unexpected Application Error!".
// ponytail: ComponentType<any> — retry wrapper is prop-agnostic by design
function lazyRetry(fn: () => Promise<{ default: ComponentType<any> }>) {
  return lazy(async () => {
    try {
      return await fn();
    } catch {
      if (!sessionStorage.getItem("ss_chunk_reload")) {
        sessionStorage.setItem("ss_chunk_reload", "1");
        window.location.reload();
      }
      throw new Error("Chunk failed — reloaded");
    }
  });
}

const AdminView = lazyRetry(() => import("@/components/home/AdminView"));
const ArchiveView = lazyRetry(() => import("@/components/home/ArchiveView"));
const SplitterTool = lazyRetry(() => import("@/components/tools/SplitterTool"));
const PoolsView = lazyRetry(() => import("@/components/home/PoolsView"));
import Fab from "@/components/home/Fab";
import FileGrid from "@/components/home/FileGrid";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { COLUMN_PRESETS, fileTypeDef, FILE_PRESET_NAMES } from "@/lib/types";
import type { FilePreset, FileType, SheetFile } from "@/lib/types";
import { downloadXlsx, genId, hydrateWaCache, importXlsx, todayStr } from "@/lib/xlsx";
import { useBubbleStore } from "@/stores/bubbleStore";

type Tab = "files" | "archive" | "pools" | "admin" | "tools";

interface AndroidBridge {
  getBubbleFile?: () => string;
  disableBubble?: () => void;
  enableBubble?: (id: string) => void;
}

function getAndroid(): AndroidBridge | null {
  try {
    return (window as unknown as { Android?: AndroidBridge }).Android ?? null;
  } catch {
    return null;
  }
}

const ReplitPoolsIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 308" aria-hidden="true" {...props}>
    <title>replit-icon</title>
    <path fill="#f26207" d="M0 19.2C0 8.596 8.596 0 19.2 0h89.6C119.404 0 128 8.596 128 19.2v83.2H19.2C8.596 102.4 0 93.804 0 83.2zm128 83.2h108.8c10.604 0 19.2 8.596 19.2 19.2v64c0 10.604-8.596 19.2-19.2 19.2H128zM0 224c0-10.604 8.596-19.2 19.2-19.2H128V288c0 10.604-8.596 19.2-19.2 19.2H19.2C8.596 307.2 0 298.604 0 288z" />
  </svg>
);

const CakephpIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 200" aria-hidden="true" {...props}>
    <title>cakephp-icon</title>
    <path fill="#d33c44" fill-rule="evenodd" d="M0 119.883c0 22.056 57.294 39.958 127.98 39.958v39.942C57.294 199.783 0 181.897 0 159.841Zm256 0v39.95c0 9.417-10.47 18.056-27.902 24.89l-100.126-24.89v-39.95l100.126 24.882c17.433-6.826 27.91-15.465 27.902-24.882M127.98 0C198.674 0 256 17.918 256 39.958v39.983c0 9.384-10.47 18.056-27.894 24.857L127.98 79.941v39.942C57.294 119.883 0 101.989 0 79.94V39.958C0 17.918 57.294 0 127.98 0" />
  </svg>
);

const RabbitmqIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 257" aria-hidden="true" {...props}>
    <title>rabbitmq-icon</title>
    <path fill="#f60" d="M245.734 102.437h-81.911a10.2 10.2 0 0 1-10.263-10.263v-81.91a10.2 10.2 0 0 0-10.263-10.2h-30.66a10.2 10.2 0 0 0-10.264 10.2v81.91a10.2 10.2 0 0 1-10.263 10.263H61.45a10.2 10.2 0 0 1-10.263-10.263v-81.91A10.2 10.2 0 0 0 40.924 0H10.199A10.2 10.2 0 0 0 0 10.263v235.535a10.2 10.2 0 0 0 10.263 10.263h235.47a10.2 10.2 0 0 0 10.264-10.263V112.893a10.2 10.2 0 0 0-10.263-10.456m-41.18 86.979a15.33 15.33 0 0 1-15.33 15.394h-20.526a15.33 15.33 0 0 1-15.33-15.394v-20.462a15.33 15.33 0 0 1 15.33-15.394h20.525a15.33 15.33 0 0 1 15.33 15.394z" />
  </svg>
);

const ObsidianIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 332" aria-hidden="true" {...props}>
    <title>obsidian-icon</title>
    <defs>
      <radialGradient id="SVGYDglUjvP" cx="72.819%" cy="96.934%" r="163.793%" fx="72.819%" fy="96.934%" gradientTransform="matrix(-.24192 0 .9703 0 13836.652 7282)"><stop offset="0%" stop-color="#fff" stop-opacity=".4"/><stop offset="100%" stop-opacity=".1"/></radialGradient>
      <radialGradient id="SVG1mgR7H8p" cx="52.917%" cy="90.632%" r="190.361%" fx="52.917%" fy="90.632%" gradientTransform="matrix(.13917 0 .99027 0 9251.091 5292)"><stop offset="0%" stop-color="#fff" stop-opacity=".6"/><stop offset="100%" stop-color="#fff" stop-opacity=".1"/></radialGradient>
      <radialGradient id="SVGzgHe6cFU" cx="31.174%" cy="97.138%" r="178.714%" fx="31.174%" fy="97.138%" gradientTransform="matrix(.22495 0 .97437 0 8312.095 3117)"><stop offset="0%" stop-color="#fff" stop-opacity=".8"/><stop offset="100%" stop-color="#fff" stop-opacity=".4"/></radialGradient>
      <radialGradient id="SVGCTY0meFQ" cx="71.813%" cy="99.994%" r="92.086%" fx="71.813%" fy="99.994%" gradientTransform="matrix(0 -7537.88511 0 -4352 0 22251839.658)"><stop offset="0%" stop-color="#fff" stop-opacity=".3"/><stop offset="100%" stop-opacity=".3"/></radialGradient>
      <radialGradient id="SVGp7NleeJb" cx="117.013%" cy="34.769%" r="328.729%" fx="117.013%" fy="34.769%" gradientTransform="matrix(-.20791 0 -.97815 0 -1213.278 1701)"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="100%" stop-color="#fff" stop-opacity=".2"/></radialGradient>
      <radialGradient id="SVGzfuNdcEV" cx="-9.431%" cy="8.712%" r="153.492%" fx="-9.431%" fy="8.712%" gradientTransform="matrix(.7071 0 -.7071 0 490.42 943)"><stop offset="0%" stop-color="#fff" stop-opacity=".2"/><stop offset="100%" stop-color="#fff" stop-opacity=".4"/></radialGradient>
      <radialGradient id="SVGHFK8RbnI" cx="103.902%" cy="-22.172%" r="394.771%" fx="103.902%" fy="-22.172%" gradientTransform="matrix(.17365 0 -.9848 0 3105.035 39)"><stop offset="0%" stop-color="#fff" stop-opacity=".1"/><stop offset="100%" stop-color="#fff" stop-opacity=".3"/></radialGradient>
      <radialGradient id="SVGBKkxAcsd" cx="99.348%" cy="89.193%" r="203.824%" fx="99.348%" fy="89.193%" gradientTransform="matrix(0 -2496.1803 0 -4694.63235 0 -38783246.548)"><stop offset="0%" stop-color="#fff" stop-opacity=".2"/><stop offset="50%" stop-color="#fff" stop-opacity=".2"/><stop offset="100%" stop-color="#fff" stop-opacity=".3"/></radialGradient>
    </defs>
    <path fill-opacity=".3" d="M209.056 308.305c-2.043 14.93-16.738 26.638-31.432 22.552c-20.823-5.658-44.946-14.616-66.634-16.266l-33.317-2.515a22 22 0 0 1-14.144-6.522L6.167 246.778a21.77 21.77 0 0 1-4.244-24.124s35.36-77.478 36.775-81.485c1.257-4.008 6.13-39.211 8.958-58.07a22 22 0 0 1 7.072-12.965L122.462 9.47a22 22 0 0 1 31.903 2.672l57.048 71.978a23.18 23.18 0 0 1 4.872 14.38c0 13.594 1.179 41.646 8.8 59.72a236.8 236.8 0 0 0 27.974 45.732a11 11 0 0 1 .786 12.258c-4.95 8.408-14.851 24.595-28.76 45.26a111.7 111.7 0 0 0-16.108 46.834z" />
    <path fill="#6c31e3" d="M209.606 305.79c-2.043 15.009-16.737 26.717-31.432 22.71c-20.744-5.737-44.79-14.695-66.555-16.345L78.38 309.64a21.92 21.92 0 0 1-14.144-6.6L6.874 244.106a21.92 21.92 0 0 1-4.243-24.36s35.438-77.792 36.774-81.878c1.336-4.007 6.13-39.289 8.958-58.305a22 22 0 0 1 7.072-13.044L123.17 5.621a22 22 0 0 1 31.902 2.75l56.97 72.292a23.34 23.34 0 0 1 4.871 14.38c0 13.673 1.18 41.804 8.723 59.955a238 238 0 0 0 27.974 45.969a11 11 0 0 1 .864 12.336c-5.03 8.487-14.851 24.674-28.838 45.497a112.6 112.6 0 0 0-16.03 46.99" />
    <path fill="url(#SVGYDglUjvP)" d="M70.365 307.44c26.638-53.983 25.93-92.722 14.537-120.225c-10.372-25.459-29.781-41.489-45.025-51.468a19.2 19.2 0 0 1-1.415 4.243L2.631 219.747a21.92 21.92 0 0 0 4.321 24.36l57.284 58.933a23.8 23.8 0 0 0 6.129 4.4" />
    <path fill="url(#SVG1mgR7H8p)" d="M142.814 197.902a86 86 0 0 1 21.06 4.793c21.844 8.172 41.724 26.56 58.147 61.999c1.179-2.043 2.357-4.008 3.615-5.894a960 960 0 0 0 28.838-45.497a11 11 0 0 0-.786-12.336a238 238 0 0 1-28.052-45.969c-7.544-18.073-8.644-46.282-8.723-59.955c0-5.186-1.65-10.294-4.871-14.38l-56.97-72.292l-.943-1.178c4.165 13.75 3.93 24.752 1.336 34.731c-2.357 9.272-6.757 17.68-11.394 26.56c-1.571 2.986-3.143 6.05-4.636 9.193a110 110 0 0 0-12.415 45.576c-.786 19.016 3.064 42.825 15.716 74.65z" />
    <path fill="url(#SVGzgHe6cFU)" d="M142.736 197.902c-12.652-31.824-16.502-55.633-15.716-74.65c.786-18.858 6.286-33.002 12.415-45.575l4.715-9.193c4.558-8.88 8.88-17.288 11.315-26.56a61.7 61.7 0 0 0-1.336-34.731c-8.136-8.94-21.96-9.642-30.96-1.572L55.436 66.519a22 22 0 0 0-7.072 13.044l-8.25 54.69c0 .55-.158 1.022-.236 1.572c15.244 9.901 34.574 25.931 45.025 51.312c2.043 5.029 3.772 10.294 5.029 16.03a157.2 157.2 0 0 1 52.805-5.343z" />
    <path fill="url(#SVGCTY0meFQ)" d="M178.253 328.5c14.616 4.007 29.31-7.701 31.353-22.789a120.2 120.2 0 0 1 12.494-41.017c-16.502-35.44-36.382-53.827-58.148-61.999c-23.18-8.643-48.404-5.736-74.021.472c5.736 26.01 2.357 60.034-19.487 104.273c2.436 1.257 5.186 1.965 7.936 2.2l34.496 2.593c18.701 1.336 46.597 11.001 65.377 16.266" />
    <path fill="url(#SVGp7NleeJb)" d="M127.177 122.074c-.864 18.859 1.493 40.39 14.144 72.135l-3.929-.393c-11.394-33.081-13.908-50.054-13.044-69.149c.786-19.094 6.994-33.789 13.123-46.361c1.571-3.143 5.186-9.037 6.758-12.023c4.557-8.879 7.622-13.515 10.215-21.609c3.772-11.315 2.986-16.658 2.514-22.001c2.908 19.251-8.172 35.988-16.501 53.04a113.9 113.9 0 0 0-13.358 46.361z" />
    <path fill="url(#SVGzfuNdcEV)" d="M88.674 188.551c1.571 3.458 2.907 6.287 3.85 10.608l-3.379.786c-1.336-5.029-2.357-8.643-4.322-12.965c-11.472-26.953-29.86-40.861-44.79-51.076c18.074 9.744 36.697 25.066 48.64 52.647" />
    <path fill="url(#SVGHFK8RbnI)" d="M92.681 202.617c6.286 29.467-.786 66.948-21.609 103.409c17.445-36.146 25.931-70.8 18.859-102.938l2.75-.55z" />
    <path fill="url(#SVGBKkxAcsd)" d="M164.659 199.867c34.181 12.808 47.383 40.86 57.205 64.355c-12.18-24.516-29.074-51.626-58.462-61.684c-22.317-7.7-41.175-6.758-73.471.55l-.707-3.143c34.26-7.858 52.176-8.8 75.435 0z" />
  </svg>
);

const WakuIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <title>google-admob</title>
    <path fill="#ea4335" d="M11.46.033h-.052A11.993 11.993 0 0 0 0 11.922v.052c0 7.475 6.563 11.928 11.447 11.928h.17a3.086 3.086 0 0 0 3.125-3.047c0-1.693-1.433-2.917-3.152-2.917h-.039a6.016 6.016 0 0 1-5.508-6.368v-.052a6.016 6.016 0 0 1 5.573-5.509c1.719 0 3.125-1.237 3.125-2.917A3.086 3.086 0 0 0 11.604.02h-.143zm2.031.026a3.52 3.52 0 0 1 1.746 3.021a3.39 3.39 0 0 1-1.928 3.047c2.865.6 4.532 3.126 4.688 5.378v7.684a3.49 3.49 0 0 1 6.003.026v-7.736A12.046 12.046 0 0 0 13.491.045zm7.475 17.932a2.995 2.995 0 1 0 .04 0z" />
  </svg>
);

const RedisIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>redis</title>
    <path fill="#a41e11" d="M121.8 93.1c-6.7 3.5-41.4 17.7-48.8 21.6s-11.5 3.8-17.3 1S13 98.1 6.3 94.9c-3.3-1.6-5-2.9-5-4.2V78s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9v12.5c0 1.3-1.5 2.7-4.9 4.4" />
    <path fill="#d82c20" d="M121.8 80.5C115.1 84 80.4 98.2 73 102.1s-11.5 3.8-17.3 1S13 85.4 6.3 82.2C-.3 79-.5 76.8 6 74.3c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.9" />
    <path fill="#a41e11" d="M121.8 72.5C115.1 76 80.4 90.2 73 94.1c-7.4 3.8-11.5 3.8-17.3 1S13 77.4 6.3 74.2c-3.3-1.6-5-2.9-5-4.2V57.3s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9V68c0 1.3-1.5 2.7-4.9 4.5" />
    <path fill="#d82c20" d="M121.8 59.8c-6.7 3.5-41.4 17.7-48.8 21.6c-7.4 3.8-11.5 3.8-17.3 1S13 64.7 6.3 61.5s-6.8-5.4-.3-7.9c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.9" />
    <path fill="#a41e11" d="M121.8 51c-6.7 3.5-41.4 17.7-48.8 21.6c-7.4 3.8-11.5 3.8-17.3 1C49.9 70.9 13 56 6.3 52.8c-3.3-1.6-5.1-2.9-5.1-4.2V35.9s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9v12.5c.1 1.3-1.4 2.6-4.8 4.4" />
    <path fill="#d82c20" d="M121.8 38.3C115.1 41.8 80.4 56 73 59.9c-7.4 3.8-11.5 3.8-17.3 1S13 43.3 6.3 40.1s-6.8-5.4-.3-7.9c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.8" />
    <path fill="#fff" d="m80.4 26.1l-10.8 1.2l-2.5 5.8l-3.9-6.5l-12.5-1.1l9.3-3.4l-2.8-5.2l8.8 3.4l8.2-2.7L72 23zM66.5 54.5l-20.3-8.4l29.1-4.4z" />
    <ellipse cx="38.4" cy="35.4" fill="#fff" rx="15.5" ry="6" />
    <path fill="#7a0c00" d="m93.3 27.7l17.2 6.8l-17.2 6.8z" />
    <path fill="#ad2115" d="m74.3 35.3l19-7.6v13.6l-1.9.8z" />
  </svg>
);

function ToolsList({ onOpenSplitter }: { onOpenSplitter: () => void }) {
  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>Tools</h2>
      <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 16 }}>Admin utilities</p>
      <div className="files-grid">
        <div
          className="file-card"
          role="button"
          tabIndex={0}
          onClick={onOpenSplitter}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenSplitter(); } }}
        >
          <div className="file-card-icon" style={{ background: "var(--blue-light)", color: "var(--blue)" }}>
            {/* icon: allsvgicons.com/lucide/scissors.svg */}
            <ObsidianIcon size={16} />
          </div>
          <div className="file-card-name">Splitter</div>
          <div className="file-card-meta">Split xlsx into N parts</div>
          <span className="file-type-badge" style={{ background: "var(--blue-light)", color: "var(--blue)" }}>Xlsx</span>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { userId } = useParams();
  const showToast = useToast();
  const confirm = useConfirm();

  // Each home section has its own URL path (mobile + desktop): / = files,
  // /files, /archive, /admin, /admin/user/:id (admin user detail). The active
  // tab is derived from the pathname so every section is deep-linkable.
  const path = location.pathname;
  const tab: Tab = path.startsWith("/pools")
    ? "pools"
    : path.startsWith("/tools")
      ? "tools"
      : path.startsWith("/admin")
        ? "admin"
        : path === "/archive"
          ? "archive"
          : "files";

  const [files, setFiles] = useState<SheetFile[] | null>(null);
  const [dupCounts, setDupCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const selectionMode = selected.size > 0;

  const loadFiles = useCallback(async () => {
    try {
      const [fs, cd] = await Promise.all([api.getFiles(), api.getCrossDups()]);
      setFiles(fs);
      setDupCounts(cd.counts ?? {});
    } catch {
      setFiles([]);
      showToast("Could not load files. Check your connection.");
    }
  }, [showToast]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await api.getFiles());
    } catch {
      showToast("Could not load files. Check your connection.");
    }
  }, [showToast]);

  useEffect(() => {
    if ((tab === "admin" || tab === "tools" || tab === "pools") && !user?.isAdmin) {
      navigate("/", { replace: true });
    }
  }, [tab, user, navigate]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const openFile = (id: string) => navigate("/file/" + id);

  // Multi-select belongs to one section: switching tabs must not leave an armed
  // selection bar behind (its Delete would act on files from the previous tab).
  const goTab = (to: string) => {
    setSelected(new Set());
    navigate(to);
  };

  const bubblePickMode = useBubbleStore((s) => s.pickMode);

  const pickBubbleFile = (id: string) => {
    const f = files?.find((x) => x.id === id);
    if (!f) return;
    if (f.type !== "fb_cookie") {
      showToast("Only Facebook files work in the bubble");
      return;
    }
    try {
      getAndroid()?.enableBubble?.(f.id);
    } catch {
      // bridge may be gone
    }
    useBubbleStore.setState({ on: true, pickMode: false });
    showToast("Floating bubble on - " + f.name);
  };

  const downloadFile = async (f: SheetFile) => {
    const rows = await api.getRows(f.id);
    if (!rows || !rows.length) {
      showToast("No data");
      return;
    }
    try {
      await downloadXlsx(rows, f.columns ?? fileTypeDef(f.type).columns, f.name);
      showToast("Downloaded");
    } catch {
      showToast("Could not download file. Check your connection.");
    }
  };

  const deleteFile = async (f: SheetFile) => {
    const ok = await confirm("Move this file to archive?", "Archive");
    if (!ok) return;
    const android = getAndroid();
    if (android) {
      try {
        if (android.getBubbleFile?.() === f.id) {
          android.disableBubble?.();
          useBubbleStore.getState().setOn(false);
          showToast("Floating bubble disabled - file archived");
        }
      } catch {
        // bridge may be gone
      }
    }
    try {
      await api.deleteFile(f.id);
    } catch {
      showToast("Could not archive file. Check your connection.");
      return;
    }
    loadFiles();
    showToast("File archived");
  };

  const openRename = (f: SheetFile) => {
    setRenameFileId(f.id);
    setRenameName(f.name);
  };

  const closeRename = () => {
    setRenameFileId(null);
    setRenameName("");
  };

  const commitRename = async () => {
    const name = renameName.trim();
    if (!name) {
      showToast("Name cannot be empty");
      return;
    }
    if (!renameFileId) return;
    try {
      await api.updateFile(renameFileId, { name });
    } catch {
      showToast("Could not rename file. Try again.");
      return;
    }
    closeRename();
    refreshFiles();
    showToast("Renamed");
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const holdSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.size === 0) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (files) setSelected(new Set(files.map((f) => f.id)));
  };

  const unselectAll = () => setSelected(new Set());

  const deleteSelected = async () => {
    if (!selectionMode) return;
    const ids = Array.from(selected);
    const ok = await confirm(
      "Move " + ids.length + " file" + (ids.length > 1 ? "s" : "") + " to archive?",
      "Archive",
    );
    if (!ok) return;
    try {
      await Promise.all(ids.map((id) => api.deleteFile(id)));
    } catch {
      showToast("Could not archive files. Check your connection.");
      return;
    }
    setSelected(new Set());
    loadFiles();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " archived");
  };

  const [pwModal, setPwModal] = useState<null | { type: FileType; preset: FilePreset; choice: string; custom: string }>(null);

  const openCreatePw = (type: FileType, preset: FilePreset) => setPwModal({ type, preset, choice: "dgddigital", custom: "" });

  const createWithPassword = async (password: string) => {
    if (!pwModal) return;
    const type = pwModal.type;
    const columns = COLUMN_PRESETS[pwModal.preset];
    const poolEnabled = password === "dgddigital";
    setPwModal(null);
    const name = FILE_PRESET_NAMES[pwModal.preset] + " " + todayStr();
    const current = files ?? (await api.getFiles());
    let finalName = name;
    if (current.some((f) => f.name === name)) {
      let suffix = 2;
      while (current.some((f) => f.name === name + " (" + suffix + ")")) suffix++;
      finalName = name + " (" + suffix + ")";
    }
    const id = genId();
    let created: import("@/lib/types").SheetFile;
    try {
      created = await api.createFile({ id, name: finalName, type, preset: pwModal.preset, poolKind: pwModal.preset, password, poolEnabled, columns });
    } catch {
      showToast("Could not create file. Check your connection.");
      return;
    }
    showToast(fileTypeDef(type).label + " file created");
    if (useBubbleStore.getState().pickMode) { loadFiles(); return; }
    navigate("/file/" + created.id);
  };

  const createFile = async (preset: FilePreset) => openCreatePw("fb_cookie", preset);

  const [uploadPending, setUploadPending] = useState<null | { id: string; name: string; type: FileType; rows: import("@/lib/types").Row[]; dataCount: number; cacheReady: Promise<void> }>(null);

  const doUploadWithPassword = async (password: string) => {
    if (!uploadPending) return;
    const { id, name, type, rows, dataCount } = uploadPending;
    const preset = pwModal?.preset ?? "page";
    setUploadPending(null);
    setPwModal(null);
    await uploadPending.cacheReady;
    let created: import("@/lib/types").SheetFile;
    try {
      created = await api.createFile({ id, name, type, preset, poolKind: preset, password, poolEnabled: password === "dgddigital", rows, dataCount });
    } catch {
      showToast("Could not import file. Check your file and try again.");
      return;
    }
    showToast("Imported " + dataCount + " rows");
    if (useBubbleStore.getState().pickMode) { loadFiles(); return; }
    navigate("/file/" + created.id);
  };

  const uploadFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const current = files ?? (await api.getFiles());
      const result = await importXlsx(buf, file.name, current);
      const isLoveName = result.name.toLowerCase().includes("love");
      // ask password before creating uploaded file — 2 cards, auto-pick L0VE if name contains Love
       const cacheReady = hydrateWaCache(result.rows);
       setUploadPending({ id: result.id, name: result.name, type: result.type, rows: result.rows, dataCount: result.dataCount, cacheReady });
      setPwModal({ type: result.type, preset: "page", choice: isLoveName ? "L0VE@12345" : "dgddigital", custom: "" });
    } catch {
      showToast("Could not import file. Check your file and try again.");
    }
  };

  return (
    <>
      <div className="home-tabs" role="tablist" aria-label="Home sections">
        <button
          className={`home-tab${tab === "files" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => goTab("/")}
        >
          <RedisIcon size={14} aria-hidden="true" />
          My Files
        </button>
        <button
          className={`home-tab${tab === "archive" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "archive"}
          onClick={() => goTab("/archive")}
        >
          <CakephpIcon size={14} aria-hidden="true" />
          Archive
        </button>
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "pools" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "pools"}
            onClick={() => goTab("/pools/dgddigital/cookies_only")}
          >
            <ReplitPoolsIcon size={14} aria-hidden="true" />
            Pools
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "admin" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "admin"}
            onClick={() => goTab("/admin")}
          >
            <WakuIcon size={14} aria-hidden="true" />
            Admin
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "tools" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "tools"}
            onClick={() => goTab("/tools")}
          >
            <RabbitmqIcon size={14} aria-hidden="true" />
            Tools
          </button>
        ) : null}
      </div>

      {tab === "files" ? (
        <div className="home-pane" id="homePaneFiles">
          {bubblePickMode ? (
            <div className="bubble-pick-banner">
              <div>
                <div className="bubble-pick-title">Choose a bubble file</div>
                <div className="bubble-pick-sub">
                  Tap a Facebook file to show it in the mini window
                </div>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => useBubbleStore.getState().setPickMode(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {files !== null ? (
            <FileGrid
              files={files}
              crossDupCounts={dupCounts}
              selectedIds={selected}
              selectionMode={selectionMode}
              onOpen={bubblePickMode ? pickBubbleFile : openFile}
              onDownload={downloadFile}
              onRename={openRename}
              onDelete={deleteFile}
              onToggleSelect={toggleSelect}
              onHoldSelect={holdSelect}
            />
          ) : null}
        </div>
      ) : null}

      {tab === "archive" ? (
        <div className="home-pane" id="homePaneArchive">
          <Suspense fallback={null}>
            <ArchiveView />
          </Suspense>
        </div>
      ) : null}

      {tab === "pools" && user?.isAdmin ? (
        <div className="home-pane" id="homePanePools" style={{ padding: "24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={null}>
            <PoolsView />
          </Suspense>
        </div>
      ) : null}

      {tab === "admin" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneAdmin">
          <Suspense fallback={null}>
            <AdminView initialUserId={userId} />
          </Suspense>
        </div>
      ) : null}

      {tab === "tools" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneTools" style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          {path === "/tools/splitter" ? (
            <Suspense fallback={null}>
              <SplitterTool />
            </Suspense>
          ) : (
            <ToolsList onOpenSplitter={() => navigate("/tools/splitter")} />
          )}
        </div>
      ) : null}

      {tab === "files" ? <Fab onCreate={createFile} onUpload={uploadFile} /> : null}

      <div className={`sel-bar${selectionMode ? " open" : ""}`}>
        <span className="sel-bar-count">{selected.size} selected</span>
        <div className="sel-bar-actions">
          <button className="sel-btn" onClick={selectAll}>
            Select All
          </button>
          <button className="sel-btn" onClick={unselectAll}>
            Unselect All
          </button>
          <button className="sel-btn danger" onClick={deleteSelected}>
            Delete
          </button>
        </div>
      </div>

      <div
        className={`modal-overlay${renameFileId ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeRename();
        }}
      >
        <div className="modal-box" role="dialog" aria-modal="true" aria-label="Rename file">
          <div className="modal-title">Rename file</div>
          <input
            className="modal-input"
            type="text"
            aria-label="File name"
            value={renameName}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                closeRename();
              }
            }}
          />
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={closeRename}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={commitRename}>
              Rename
            </button>
          </div>
        </div>
      </div>

      <div className={`modal-overlay${pwModal ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) { setPwModal(null); setUploadPending(null); } }}>
        <div className="modal-box" role="dialog" aria-modal="true" aria-label="Pick a password" style={{ width: 340 }}>
          <div className="modal-title">Pick a password</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 12 }}>
            {[
              { id: "dgddigital" },
              { id: "L0VE@12345" },
            ].map((c) => (
              <button
                key={c.id}
                className="file-card"
                style={{ textAlign: "center", padding: 14, minHeight: 56, justifyContent: "center", alignItems: "center", borderColor: "var(--border2)" }}
                onClick={() => { if (uploadPending) doUploadWithPassword(c.id); else createWithPassword(c.id); }}
              >
                <span className="file-card-name" style={{ fontSize: 13, fontWeight: 600 }}>{c.id}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

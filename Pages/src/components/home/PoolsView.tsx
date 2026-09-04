import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import type { PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import DownloadDetailModal from "./DownloadDetailModal";

const PASSWORDS = ["dgddigital", "L0VE@12345"] as const;
const POOL_TABS = [
  { id: "cookies_only", label: "Cookies", badge: "Cookies" },
  { id: "cookies_2fa", label: "2FA", badge: "2FA" },
  { id: "page", label: "Page", badge: "Page" },
] as const;
type PoolId = (typeof POOL_TABS)[number]["id"];

const CookieIcon = ({ size = 12, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 192 192" aria-hidden="true" {...props}>
    <title>google-workspace-admin</title>
    <path fill="#4285f4" d="M73.508 16.406q2.719.003 5.438 0q5.682.004 11.362.052c4.847.04 9.693.044 14.539.036c3.739-.003 7.478.01 11.217.026q2.68.011 5.36.01c2.499.002 4.996.023 7.495.05l2.22-.009c5.38.09 9.409 1.341 13.53 4.851c4.393 5.243 7.584 11.015 10.83 17.015q1.844 3.35 3.693 6.696l1.899 3.442c3.042 5.456 6.188 10.85 9.347 16.237l3.308 5.645l1.594 2.717q1.79 3.047 3.59 6.085l1.918 3.252l1.754 2.964c2.849 5.144 3.15 9.776 2.398 15.525c-3.285 8.081-7.996 15.635-12.437 23.125a6420 6420 0 0 0-3.684 6.258l-1.917 3.258c-2.021 3.46-4.014 6.933-5.997 10.413l-2.008 3.516a1923 1923 0 0 0-3.806 6.7C144.779 172.407 144.779 172.407 137 175c-2.594.111-5.162.167-7.757.177l-2.391.02q-3.918.028-7.836.041l-2.707.012q-7.092.031-14.185.045c-4.877.011-9.753.045-14.63.085c-3.756.026-7.512.035-11.268.038q-2.695.008-5.391.035c-2.521.025-5.04.024-7.56.017c-.737.013-1.474.025-2.233.04c-5.538-.057-8.574-1.48-13.042-4.51c-1.984-2.17-1.984-2.17-3.527-4.524c-.58-.88-1.157-1.762-1.754-2.67c-2.902-4.736-5.62-9.557-8.281-14.43a1271 1271 0 0 0-16.731-29.32A2317 2317 0 0 1 13 112l-1.474-2.51l-1.362-2.369l-1.193-2.057c-2.178-4.63-2.73-9.424-1.312-14.359c2.683-6.588 5.997-12.612 9.654-18.705l3.742-6.324l1.956-3.299c2.02-3.432 4.016-6.879 5.997-10.334l.999-1.742q2.381-4.152 4.754-8.307A984 984 0 0 1 40 33l1.716-3.029l1.726-2.92l1.494-2.585c7.722-9.225 17.425-8.17 28.572-8.06m3.298 47.224C75.21 66.004 74.134 68.376 73 71a251 251 0 0 1-3.683 5.734a2875 2875 0 0 0-3.754 6.016l-1.967 3.074l-1.842 2.973l-1.677 2.667C58.737 94.62 58.876 95.78 60 99a118 118 0 0 0 3.746 6.761c.37.632.743 1.264 1.125 1.915a991 991 0 0 0 2.358 3.981q1.81 3.046 3.6 6.103l2.292 3.876l1.086 1.844c1.452 2.43 2.782 4.51 4.793 6.52c10.592 2.296 24.742 4.25 35 0c8.098-5.926 12.167-16.982 15.768-25.998C131 101 131 101 133 98c-.248-4.958-2.187-8.536-4.781-12.64l-1.132-1.844a924 924 0 0 0-3.587-5.766q-1.21-1.956-2.418-3.914a1476 1476 0 0 0-3.402-5.495c-1.3-2.085-2.58-4.142-3.68-6.34a620 620 0 0 0-14.624-.496a250 250 0 0 1-4.97-.184c-13.647-.628-13.647-.628-17.6 2.31" />
    <path fill="#4285f4" d="m62.886 16.725l2.396-.015c2.612-.014 5.223-.013 7.835-.01l5.455-.014q5.717-.01 11.434-.002c4.878.006 9.756-.01 14.634-.034c3.756-.015 7.511-.016 11.267-.013q2.697 0 5.395-.016c2.518-.012 5.035-.005 7.553.006l2.24-.023c5.411.055 9.43 1.288 13.575 4.818c4.392 5.243 7.583 11.015 10.83 17.015q1.843 3.35 3.691 6.695l1.9 3.443c3.041 5.455 6.188 10.85 9.346 16.237c.555.946 1.11 1.892 1.68 2.867l1.63 2.778l1.592 2.717q1.79 3.045 3.591 6.085l1.917 3.252l1.755 2.964c2.85 5.147 3.146 9.773 2.398 15.525c-3.466 8.588-8.552 16.603-13.25 24.562l-1.89 3.23c-4.518 7.694-4.518 7.694-6.86 11.208h-2c-1.107-1.487-1.107-1.487-2.328-3.602l-1.405-2.395l-1.517-2.628a846 846 0 0 0-14.375-23.563l-1.829-2.914l-1.71-2.69l-1.514-2.393C135 98 135 98 133 97a67 67 0 0 1-2.168-4.313c-3.518-7.256-7.839-13.988-12.1-20.824l-1.846-2.988l-1.68-2.696C114 64 114 64 114 62l-2.448.107C82.348 63.318 53.212 62.722 24 62c3.995-8.28 8.336-16.31 13.014-24.222c1.06-1.799 2.106-3.607 3.152-5.415q1.026-1.745 2.056-3.488l1.837-3.133c5.037-7.116 10.433-9.045 18.827-9.017" />
    <path fill="#4285f4" d="m26.17 61.88l2.9.007h3.276l3.564.016c1.197 0 2.394.002 3.628.004q5.762.01 11.524.03q3.895.009 7.791.014Q68.427 61.967 78 62c-1.33 4.546-3.156 8.132-5.73 12.098q-1.092 1.713-2.182 3.428a830 830 0 0 1-3.438 5.318a524 524 0 0 0-3.318 5.19l-2.009 3.107C60 94 60 94 60.057 96.453c1.224 3.307 2.878 6.264 4.69 9.274c.184.315.184.315 1.124 1.907a1389 1389 0 0 0 3.566 5.99l2.393 4.048c5.665 9.57 5.665 9.57 8.17 13.328c-7.866.085-15.73.1-23.596.067c-2.677-.008-5.349.01-8.026.039c-3.849.04-7.694.02-11.542-.008l-3.618.074c-8.127-.14-8.127-.14-11.25-3.092c-1.553-2.301-2.774-4.577-3.968-7.08a292 292 0 0 0-2.739-4.465a941 941 0 0 1-2.574-4.472c-.44-.734-.883-1.468-1.338-2.225c-3.526-6.194-5.512-12.216-3.724-19.322c2.4-6.43 5.97-12.257 9.562-18.078l1.654-2.73c4.68-7.681 4.68-7.681 7.33-7.828" />
    <path fill="#1967d2" d="M24 130c7.58-.228 15.159-.386 22.742-.494q3.867-.069 7.734-.185a598 598 0 0 1 11.126-.2l3.485-.141c7.805-.005 7.805-.005 10.85 2.811c1.581 2.332 2.834 4.676 4.063 7.209a226 226 0 0 0 2.394 3.896q1.143 1.919 2.278 3.842l1.238 2.085q1.276 2.153 2.55 4.308q1.949 3.293 3.903 6.582q1.25 2.106 2.496 4.213l1.171 1.973c1.765 2.989 3.44 5.986 4.97 9.101c-6.992.102-13.985.172-20.978.22q-3.565.03-7.132.082c-3.423.048-6.845.071-10.269.089l-3.205.062c-6.385.002-10.267-.573-15.416-4.453c-1.96-2.13-1.96-2.13-3.484-4.453l-1.748-2.662c-3.147-5.136-6.113-10.359-9.018-15.635l-1.852-3.324c-2.736-4.93-5.401-9.87-7.898-14.926" />
    <path fill="#1967d2" d="M60.044 16.773h3.033c1.073.01 2.146.02 3.25.032l3.347.008c3.526.012 7.05.037 10.576.062q3.585.015 7.172.027Q96.21 16.936 105 17c-4.597 8.6-9.478 17.01-14.46 25.392a2925 2925 0 0 0-3.903 6.594L84.14 53.19l-1.171 1.986C81.463 57.703 80.089 59.91 78 62c-2.291.24-2.291.24-5.184.227H69.54l-3.548-.032l-3.623-.008c-3.832-.011-7.663-.037-11.494-.062q-3.889-.016-7.777-.027Q33.549 62.064 24 62c4.074-8.255 8.329-16.3 13.014-24.221a748 748 0 0 0 3.152-5.416q1.027-1.745 2.057-3.488l1.836-3.133c4.062-5.738 8.949-9.005 15.985-8.97" />
    <path fill="#1967d2" d="M162 52c2.99 2.625 4.696 5.697 6.652 9.137l1.035 1.813q1.081 1.898 2.156 3.8q1.626 2.874 3.264 5.74C186.444 92.396 186.444 92.396 185 101c-3.556 8.571-8.542 16.587-13.25 24.562l-1.891 3.229c-4.516 7.695-4.516 7.695-6.859 11.209h-2c-1.106-1.487-1.106-1.487-2.328-3.602l-1.406-2.394l-1.516-2.629c-3.443-5.894-6.937-11.724-10.691-17.426l-1.955-2.98a547 547 0 0 0-3.822-5.719l-1.739-2.652l-1.562-2.328c-1.278-2.956-1.002-4.235.019-7.27c1.439-2.732 1.439-2.732 3.281-5.684l2.041-3.293l2.178-3.461l2.196-3.525c2.09-3.353 4.195-6.696 6.304-10.037l1.621-2.567c6.996-11.05 6.996-11.05 8.379-12.433" />
  </svg>
);

const TwoFaIcon = ({ size = 12, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 -11 960 876" width={size} height={size} aria-hidden="true" {...props}>
    <path d="M960 427c0 44.7-36.2 80.9-80.9 80.9H600L480 265.2 609.5 40.9C631.9 2.2 681.3-11 720 11.3c38.7 22.4 51.9 71.8 29.6 110.5L620.1 346.1h259c44.7 0 80.9 36.2 80.9 80.9z" fill="#1a73e8" />
    <path d="M720 842.7c-38.7 22.3-88.1 9.1-110.5-29.6L480 588.8 350.5 813.1c-22.4 38.7-71.8 51.9-110.5 29.6-38.7-22.4-51.9-71.8-29.6-110.5l129.5-224.3 140.1-5.3 140.1 5.3 129.5 224.3c22.3 38.7 9.1 88.1-29.6 110.5z" fill="#ea4335" />
    <path d="M480 265.2l-36.5 99.2-103.6-18.3-129.5-224.3c-22.3-38.7-9.1-88.1 29.6-110.5 38.7-22.3 88.1-9.1 110.5 29.6z" fill="#fbbc04" />
    <path d="M459.1 346.1l-93.9 161.8H80.9C36.2 507.9 0 471.7 0 427s36.2-80.9 80.9-80.9z" fill="#34a853" />
    <path d="M620.1 507.9H339.9L480 265.2z" fill="#185db7" />
  </svg>
);

const PageIcon = ({ size = 12, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>ollama</title>
    <path fill="currentColor" d="M17.94 125.975c-1.328-4.78-.267-14.335 2.11-18.992c1.062-2.084 1.062-2.084-.519-5.002c-4.036-7.453-4.31-18.279-.692-27.318c1.37-3.424 1.37-3.424.003-5.959c-5.619-10.41-3.848-22.86 4.502-31.66c3.62-3.815 3.62-3.815 3.176-6.515c-1.438-8.734.373-20.617 3.943-25.87c6.444-9.484 16.241-3.814 18.853 10.91c.353 1.99.704 3.704.78 3.807s1.778-.468 3.78-1.269c7.248-2.9 14.003-2.8 20.681.304c1.9.884 3.495 1.542 3.542 1.462c.048-.08.368-1.863.711-3.964C81.25 1 91.191-4.921 97.7 4.659c3.573 5.258 5.387 17.18 3.937 25.87c-.451 2.7-.451 2.7 2.894 6.21c8.381 8.793 10.265 21.377 4.73 31.595c-1.49 2.753-1.49 2.753-.197 5.694c3.853 8.763 3.673 20.372-.432 27.953c-1.581 2.918-1.581 2.918-.518 5.002c2.376 4.657 3.437 14.211 2.11 18.992c-.563 2.025-.563 2.025-4.115 2.025s-3.552 0-3.08-1.755c1.276-4.736.571-12.311-1.56-16.796c-2.466-5.184-2.465-5.131-.1-8.964c4.587-7.43 4.684-17.018.26-25.616c-2.064-4.01-2.05-4.469.254-7.891c8.675-12.891.254-30.435-14.981-31.21c-4.72-.24-4.72-.24-5.883-2.569c-6.442-12.9-25.928-13.5-33.46-1.031c-1.945 3.221-1.945 3.221-6.482 3.517C25.41 36.71 16.086 57.975 26.865 68.1c1.712 1.609 1.648 2.924-.33 6.769c-4.425 8.598-4.328 18.186.258 25.616c2.366 3.833 2.366 3.78-.098 8.964c-2.133 4.485-2.837 12.06-1.561 16.796c.472 1.755.472 1.755-3.08 1.755s-3.552 0-4.115-2.025zm20.79-97.129c4.504-.46 4.821-.985 4.378-7.23c-.634-8.923-3.835-15.995-6.251-13.808c-3.296 2.982-5.556 22.898-2.465 21.711c.447-.171 2.4-.474 4.338-.673m56.11-5.926c-.04-10.714-3.021-18.058-5.95-14.654c-2.634 3.062-5.13 16.32-3.592 19.072c.521.932 7.096 2.471 9.024 2.112c.325-.06.53-2.652.517-6.53zM56.213 83.552c-19.558-5.52-13.155-29.651 7.868-29.651c18.95 0 27.119 20.158 11.417 28.175c-4.221 2.156-14.179 2.918-19.285 1.476M73.087 78.2c11.73-5.37 5.16-19.86-9.006-19.86c-16.164 0-20.925 17.235-5.813 21.047c3.772.951 11.5.332 14.82-1.187zm-10.896-6.23c0-1.564-.343-2.395-1.35-3.27c-2.518-2.19-1.387-3.196 3.51-3.123c3.993.058 5.126 1.477 2.596 3.25c-.922.647-1.246 1.397-1.246 2.888c0 1.877-.119 2.025-1.755 2.183c-1.707.164-1.755.112-1.755-1.928m-26.214-9.017c-1.516-1.516-1.687-3.43-.51-5.706c2.28-4.409 8.364-3.014 8.364 1.918c0 4.24-4.994 6.648-7.854 3.788M85.91 62.7c-2.063-2.063-2.168-4.901-.253-6.816c2.224-2.224 5.513-1.587 7.04 1.363c2.651 5.13-2.761 9.478-6.787 5.453" />
  </svg>
);

const UnknownUserIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);

const POOL_META: Record<string, { label: string; Icon: typeof CookieIcon }> = {
  cookies_only: { label: "Cookies", Icon: CookieIcon },
  cookies_2fa: { label: "2FA", Icon: TwoFaIcon },
  page: { label: "Page", Icon: PageIcon },
};

function displayName(u: PoolDetail["users"][number]) {
  const name = (u.displayName || u.displayName === undefined ? (u as unknown as { displayName?: string }).displayName : "")?.trim() ?? "";
  const uname = (u as unknown as { username?: string }).username;
  const raw: Record<string, unknown> = u as unknown as Record<string, unknown>;
  const n = String(raw["name"] ?? raw["displayName"] ?? "").trim();
  const un = String(raw["username"] ?? "").trim();
  if (n && un) return { line1: n, line2: "@" + un };
  if (un) return { line1: "@" + un, line2: "" };
  if (n) return { line1: n, line2: "#" + u.userId.slice(-6) };
  if (name) return { line1: name, line2: uname ? "@" + uname : "#" + u.userId.slice(-6) };
  return { line1: "#" + u.userId, line2: "" };
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const w = window as unknown as { Android?: { download?: (n: string, d: string) => void } };
  if (typeof w.Android?.download === "function") {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      w.Android!.download!(filename, dataUrl);
    };
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PoolsView() {
  const params = useParams<{ password: string; poolId: string }>();
  const navigate = useNavigate();
  const showToast = useToast();
  const confirm = useConfirm();

  const curPwd = PASSWORDS.includes(params.password as never) ? params.password! : "dgddigital";
  const cur = (POOL_TABS.find((t) => t.id === params.poolId)?.id as PoolId) || "cookies_only";

  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [search, setSearch] = useState("");
  const [poolQty, setPoolQty] = useState<number | "all">(10);
  const [customQty, setCustomQty] = useState("");
  const [customFocused, setCustomFocused] = useState(false);
  const [menuUser, setMenuUser] = useState<string | null>(null);
  const [dlUser, setDlUser] = useState<PoolDetail["users"][number] | null>(null);
  const [perQty, setPerQty] = useState<number | "all">(10);
  const [perCustom, setPerCustom] = useState("");
  const [perCustomFocused, setPerCustomFocused] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloads, setDownloads] = useState<unknown[] | null>(null);
  const [reDownloading, setReDownloading] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userFiles, setUserFiles] = useState<PoolUserFile[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [verified, setVerified] = useState<VerifiedCounts | null>(null);
  const [adminMap, setAdminMap] = useState<Map<string, { name: string; username?: string; photoUrl?: string | null }>>(new Map());
  const [srcUid, setSrcUid] = useState<string>("");
  const [srcFileId, setSrcFileId] = useState<string>("");
  const [verifiedFilter, setVerifiedFilter] = useState<"all" | "verified" | "unverified">("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const ps = await api.getPools();
      const list = (ps as { pools: PoolSummary[] }).pools ?? (ps as unknown as PoolSummary[]);
      setPools(list);
      const d = await api.getPoolDetail(curPwd, cur);
      setDetail(d);
      try {
        const dls = await api.getDownloads() as unknown;
        const arr: unknown[] = Array.isArray(dls) ? dls : ((dls as { downloads?: unknown[] })?.downloads ?? []);
        setDownloads((arr as unknown[]).slice(0, 10));
      } catch { /* ignore history */ }
      try {
        const uf = await api.getUserFiles(curPwd, cur);
        setUserFiles(uf.users);
      } catch { setUserFiles(null); }
    } catch {
      showToast("Could not load pools. Check your connection.");
    }
  }, [cur, curPwd, showToast]);

  useEffect(() => { load(); }, [load]);

  // verified counts only on page tab — bounded scan, safe
  useEffect(() => {
    if (cur !== "page") { setVerified(null); return; }
    let cancelled = false;
    api.getVerifiedCounts(curPwd, cur).then((r) => { if (!cancelled) setVerified(r); }).catch(() => { if (!cancelled) setVerified(null); });
    return () => { cancelled = true; };
  }, [cur, curPwd]);

  // claimer avatars from existing adminUsers API (fallback initials)
  useEffect(() => {
    let cancelled = false;
    api.adminUsers().then((us) => {
      if (cancelled) return;
      const m = new Map<string, { name: string; username?: string; photoUrl?: string | null }>();
      for (const u of us as unknown as { id: string; firstName?: string; lastName?: string; username?: string; photoUrl?: string | null }[]) {
        const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || (u.username ? `@${u.username}` : u.id);
        m.set(u.id, { name, username: u.username, photoUrl: u.photoUrl });
      }
      setAdminMap(m);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // reset file selector when contributor changes or pool changes
  useEffect(() => { setSrcFileId(""); }, [srcUid]);
  useEffect(() => { setSrcUid(""); setSrcFileId(""); setVerifiedFilter("all"); }, [cur, curPwd]);

  const poolCounts: Record<string, number> = {};
  if (pools) pools.filter((p) => (p as unknown as Record<string, unknown>)["password"] === curPwd || !(p as unknown as Record<string, unknown>)["password"]).forEach((p) => { poolCounts[p.id] = p.available; });

  const poolMeta = POOL_TABS.find((t) => t.id === cur) ?? POOL_TABS[0];
  const totals = detail?.totals ?? { available: 0, claimed: 0, users: 0 };

  const filtered = detail ? detail.users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const d = displayName(u);
    return [d.line1, d.line2, u.userId].some((s) => s.toLowerCase().includes(q));
  }) : [];

  const go = (pwd: string, pid: string) => navigate(`/pools/${pwd}/${pid}`);

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    if (!userFiles) {
      setLoadingFiles(true);
      try {
        const uf = await api.getUserFiles(curPwd, cur);
        setUserFiles(uf.users);
      } catch { /* ignore */ }
      setLoadingFiles(false);
    }
  };

  const getUserFilesFor = (userId: string) => userFiles?.find((u) => u.userId === userId);

  const srcFileOptions = useMemo(() => {
    if (!srcUid) return [];
    const u = userFiles?.find((x) => x.userId === srcUid);
    return u?.files ?? [];
  }, [srcUid, userFiles]);

  const doPoolClaim = async () => {
    const n = customQty ? Number(customQty) : poolQty;
    if (!totals.available) return showToast("No rows available to claim");
    setDownloading(true);
    try {
      const res = await api.claimPool(curPwd, cur, {
        count: n,
        srcUid: srcUid || undefined,
        srcFileId: srcFileId || undefined,
        verifiedOnly: cur === "page" && verifiedFilter === "verified" ? true : undefined,
        unverifiedOnly: cur === "page" && verifiedFilter === "unverified" ? true : undefined,
      });
      if (!res.claimed) return showToast("No rows available to claim");
      const filename = (res as unknown as { filename?: string }).filename || (cur === "cookies_only" ? "cookies_pool.xlsx" : cur === "cookies_2fa" ? "2fa_pool.xlsx" : "page_pool.xlsx");
      const downloadId = (res as unknown as { downloadId?: string }).downloadId;
      if (downloadId) {
        const blob = await api.getDownloadBlob(downloadId);
        triggerBlobDownload(blob, filename);
      } else {
        const XLSX = await import("xlsx");
        const cols = cur === "cookies_only" ? ["cookies"] : ["cookies", "twofakey"];
        const data = (res.rows as Record<string, unknown>[]).map((r) => cols.map((c) => String(r[c] ?? "")));
        const ws = XLSX.utils.aoa_to_sheet(data as string[][]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1"); XLSX.writeFile(wb, filename);
      }
      showToast(`Claimed ${res.claimed} from ${poolMeta.label} — ${filename}`);
      await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doUserClaim = async () => {
    if (!dlUser) return;
    const n = perCustom ? Number(perCustom) : perQty;
    setDownloading(true);
    try {
      const res = await api.claimPool(curPwd, cur, { count: n, userId: dlUser.userId });
      if (!res.claimed) return showToast("No rows available to claim");
      const filename = (res as unknown as { filename?: string }).filename || (cur === "cookies_only" ? "cookies_pool.xlsx" : cur === "cookies_2fa" ? "2fa_pool.xlsx" : "page_pool.xlsx");
      const downloadId = (res as unknown as { downloadId?: string }).downloadId;
      if (downloadId) {
        const blob = await api.getDownloadBlob(downloadId);
        triggerBlobDownload(blob, filename);
      } else {
        const XLSX = await import("xlsx");
        const cols = cur === "cookies_only" ? ["cookies"] : ["cookies", "twofakey"];
        const data = (res.rows as Record<string, unknown>[]).map((r) => cols.map((c) => String(r[c] ?? "")));
        const ws = XLSX.utils.aoa_to_sheet(data as string[][]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1"); XLSX.writeFile(wb, filename);
      }
      showToast(`Claimed ${res.claimed} from ${displayName(dlUser).line1}`);
      setDlUser(null); await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doRedownload = async (id: string, filename: string) => {
    setReDownloading(id);
    try {
      const blob = await api.getDownloadBlob(id);
      triggerBlobDownload(blob, filename || "download.xlsx");
      showToast(`Downloaded ${filename || id}`);
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setReDownloading(null); }
  };
  const doRevert = async (id: string) => {
    const ok = await confirm("Return these rows to the pool?", "Return");
    if (!ok) return;
    setReverting(id);
    try {
      await api.revertDownload(id);
      showToast("Rows returned to pool");
      await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setReverting(null); }
  };

  const openFile = async (u: PoolDetail["users"][number]) => {
    setMenuUser(null);
    try {
      const r = await api.getPoolRows(curPwd, cur, { userId: u.userId, limit: 1 });
      const first = r.rows[0] as Record<string, unknown> | undefined;
      const fid = first?.["srcFileId"] as string | undefined;
      if (fid) { navigate(`/admin/user/${u.userId}/file/${fid}`); return; }
    } catch {}
    showToast("No file found for this user");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .pool-switch{display:inline-flex;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;gap:3px}
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2)}
        .badge.page{background:#fffbeb;color:#b45309;border-color:#fde68a}
        .badge.taken{background:var(--bg3);color:var(--text3)}
        .admin-wrap{position:relative;display:inline-flex;flex-shrink:0}
        .admin-dot{position:absolute;right:-3px;bottom:-3px;width:14px;height:14px;border-radius:50%;background:var(--blue);border:2px solid var(--bg);display:grid;place-items:center;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15)}
        .taken-row td{position:relative}
        .taken-row td .cell-text{color:rgba(255,255,255,.72)!important}
        .user-row{cursor:pointer;transition:background .1s}
        .user-row:hover{background:var(--bg2)}
        .expand-icon{transition:transform .15s;display:inline-flex}
        .expand-icon.open{transform:rotate(90deg)}
        .file-row{animation:fadeIn .15s}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        .card-list{display:flex;flex-direction:column;gap:8px}
        .pool-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.pool-card:hover{border-color:var(--text3);box-shadow:var(--shadow-md);transform:translateY(-1px)}}
        .pool-card:active{transform:scale(.99)}
        .pool-card.expanded{border-color:var(--blue);background:var(--blue-light)}
        .pool-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
        .pool-card-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);display:flex;align-items:center;gap:8px}
        .pool-card-sub{font-size:12px;color:var(--text3);display:flex;align-items:center;gap:8px}
        .pool-card-stats{display:flex;align-items:center;gap:10px;flex-shrink:0}
        .pool-card-stat{font-size:12px;font-family:var(--mono);font-weight:600;white-space:nowrap}
        .pool-card-actions{display:flex;gap:6px;flex-shrink:0}
        .file-card{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.file-card:hover{border-color:var(--text3);box-shadow:var(--shadow-sm)}}
        .file-card:active{transform:scale(.99)}
        .file-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
        .file-card-id{font-size:12px;font-family:var(--mono);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .file-card-stats{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .file-card-stat{font-size:12px;font-family:var(--mono);font-weight:600}
        .dl-card{display:grid;grid-template-columns:auto 36px 1fr auto;gap:12px;align-items:center}
        .dl-card .pool-card-actions{justify-self:end}
        @media(max-width:640px){.dl-card{grid-template-columns:36px 1fr;gap:10px}.dl-card .badge{grid-column:1/-1;justify-self:start}.dl-card .pool-card-actions{grid-column:1/-1;width:100%;justify-content:flex-end}}
        @media(max-width:640px){.pools-stack{flex-direction:column;align-items:stretch}.pools-switch{width:100%}.pools-switch button{flex:1;justify-content:center}.pools-toolbar{flex-direction:column;align-items:stretch}.pools-qty{width:100%}.pools-qty button{flex:1}.pools-download{width:100%;height:44px;justify-content:center}.pools-stats{grid-template-columns:1fr!important}.pool-card{flex-wrap:wrap}.pool-card-actions{width:100%;justify-content:flex-end}}
      `}</style>

      {/* header + switches */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em" }}>Pools</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="pool-switch" style={{ background: "#eef2ff", borderColor: "#ddd6fe" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}>{p}</button>
            ))}
          </div>
          <div className="pool-switch">
            {POOL_TABS.map((t) => (
              <button key={t.id} className={cur === t.id ? "active" : ""} onClick={() => go(curPwd, t.id)}>
                {t.label} <span className="badge" style={{ marginLeft: 6 }}>{poolCounts[t.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* stats */}
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Available in {poolMeta.label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.available}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>{cur === "cookies_only" ? "Cookies only" : cur === "cookies_2fa" ? "Cookies + 2FA" : "Full"}</div>
          {cur === "page" && verified ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--green)", fontFamily: "var(--mono)" }}>{verified.verified}</span> verified</span>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--text3)", fontFamily: "var(--mono)" }}>{verified.unverified}</span> unverified</span>
              {verified.truncated ? <span style={{ fontSize: 11, color: "var(--text3)" }} title={`scan cap ${verified.scanCap}`}>· approx</span> : null}
            </div>
          ) : null}
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Claimed</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.claimed}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>By contributors</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Contributors</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.users}</div>
        </div>
      </div>

      {/* toolbar — source selector before main Download */}
      <div className="pools-toolbar pools-stack" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>
            Source
            <select
              aria-label="Source contributor"
              value={srcUid}
              onChange={(e) => setSrcUid(e.target.value)}
              style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36, maxWidth: 160 }}
            >
              <option value="">All contributors</option>
              {(((userFiles as unknown as { userId: string }[] | null) ?? (detail?.users as unknown as { userId: string }[] | null) ?? []) as { userId: string }[]).map((u) => {
                const du = detail?.users.find((x) => x.userId === u.userId);
                const label = du ? displayName(du).line1 : u.userId.slice(-6);
                return <option key={u.userId} value={u.userId}>{label} · {u.userId.slice(-6)}</option>;
              })}
            </select>
          </label>
          {srcUid ? (
            <select
              aria-label="Source file"
              value={srcFileId}
              onChange={(e) => setSrcFileId(e.target.value)}
              style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36, maxWidth: 160 }}
            >
              <option value="">All files</option>
              {srcFileOptions.map((f) => (
                <option key={f.fileId} value={f.fileId}>#{f.fileId.slice(-8)} · {f.available} avail</option>
              ))}
            </select>
          ) : null}
          {cur === "page" ? (
            <select
              aria-label="Page verified filter"
              value={verifiedFilter}
              onChange={(e) => setVerifiedFilter(e.target.value as never)}
              style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36 }}
            >
              <option value="all">All pages</option>
              <option value="verified">Verified only</option>
              <option value="unverified">Unverified only</option>
            </select>
          ) : null}
          <div className="pools-qty" style={{ display: "inline-flex", border: "1px solid var(--border2)", borderRadius: 8, overflow: "hidden" }}>
            {[10, 50, 100].map((n) => (
              <button key={n} onClick={() => { setPoolQty(n); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === n && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === n && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>{n}</button>
            ))}
            <button onClick={() => { setPoolQty("all"); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === "all" && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === "all" && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>All</button>
            <input
              placeholder={customFocused ? "" : "Custom"}
              aria-label="Custom quantity"
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value.replace(/\D/g, ""))}
              onFocus={(e) => { setCustomFocused(true); e.currentTarget.select(); }}
              onBlur={() => setCustomFocused(false)}
              style={{ width: 72, border: "none", padding: "7px 8px", fontSize: 13, textAlign: "center", outline: "none", background: customQty ? "var(--bg3)" : customFocused ? "var(--bg)" : "var(--bg)", borderLeft: customFocused ? "1px solid var(--border2)" : "none", cursor: customQty || customFocused ? "text" : "pointer" }}
            />
          </div>
          <button className="btn btn-primary pools-download" disabled={downloading || !totals.available} onClick={doPoolClaim} style={{ boxShadow: "0 1px 6px rgba(0,112,243,.18)", fontWeight: 600 }}>Download {customQty ? Number(customQty) || 0 : poolQty === "all" ? "All" : poolQty} from {poolMeta.label}</button>
        </div>
      </div>

      {/* search */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, marginBottom: 8 }}>
        <label style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 10, color: "var(--text3)", pointerEvents: "none" }}><circle cx="11" cy="11" r="7" /><path d="M20 20L16 16" /></svg>
          <input className="admin-search-input" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" style={{ width: 240, maxWidth: "48vw", paddingLeft: 32 }} />
        </label>
      </div>

      {/* user list */}
      <div className="card-list" style={{ marginTop: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 13, border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>No contributors yet</div>
        ) : filtered.map((u) => {
          const d = displayName(u);
          const isAdmin = (u as unknown as Record<string, unknown>)["isAdmin"] as boolean | undefined;
          const expanded = expandedUser === u.userId;
          const uf = getUserFilesFor(u.userId);
          return (
            <div key={u.userId} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div className={`pool-card ${expanded ? "expanded" : ""}`} role="button" tabIndex={0} aria-expanded={expanded} onClick={() => toggleExpand(u.userId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(u.userId); } }}>
                <span className={`expand-icon ${expanded ? "open" : ""}`} style={{ color: "var(--text3)", flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
                </span>
                <span className="admin-wrap">
                  {u.photoUrl ? <img src={u.photoUrl} alt="" style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", border: "1.5px solid var(--border)" }} /> : <span style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bg3)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14, border: "1.5px solid var(--border)", color: "var(--text2)" }}>{d.line1.charAt(0).toUpperCase()}</span>}
                  {isAdmin ? <span className="admin-dot"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M5 13l4 4L19 7" /></svg></span> : null}
                </span>
                <div className="pool-card-info">
                  <div className="pool-card-name">{d.line1}{uf ? <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>{uf.files.length} file{uf.files.length !== 1 ? "s" : ""}</span> : null}</div>
                  {d.line2 ? <div className="pool-card-sub">{d.line2}</div> : null}
                </div>
                <div className="pool-card-stats">
                  <span className="pool-card-stat" style={{ color: "var(--green)" }}>{u.available}</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>/</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>{u.claimed}</span>
                </div>
                <div className="pool-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn" aria-label="More options" style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }} onClick={() => setMenuUser(menuUser === u.userId ? null : u.userId)}>⋯</button>
                  {menuUser === u.userId ? (
                    <div style={{ position: "absolute", right: 8, top: 40, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--rl)", boxShadow: "var(--shadow-lg)", zIndex: 10, minWidth: 160, padding: 4 }}>
                      <button style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontWeight: 500 }} onClick={() => openFile(u)}>View file</button>
                      <button style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "var(--blue)", color: "#fff", cursor: "pointer", borderRadius: 6, fontWeight: 700, marginTop: 4 }} onClick={() => { setMenuUser(null); setDlUser(u); setPerQty(10); setPerCustom(""); }}>Download</button>
                      {isAdmin ? <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 10px" }}>Admin</div> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              {expanded && (
                <div className="file-row" style={{ padding: "4px 0 8px 42px" }}>
                  {loadingFiles && !uf ? (
                    <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>Loading...</div>
                  ) : !uf || uf.files.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>No files in pool</div>
                  ) : (
                    <div className="card-list">
                      {uf.files.map((f) => (
                        <div key={f.fileId} className="file-card" role="button" tabIndex={0} onClick={() => navigate(`/admin/user/${u.userId}/file/${f.fileId}`)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/admin/user/${u.userId}/file/${f.fileId}`); } }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text3)", flexShrink: 0 }}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                          <div className="file-card-info">
                            <div className="file-card-id">#{f.fileId.slice(-8)}</div>
                          </div>
                          <div className="file-card-stats">
                            <span className="file-card-stat" style={{ color: "var(--green)" }}>{f.available} avail</span>
                            <span className="file-card-stat" style={{ color: "var(--text3)" }}>/</span>
                            <span className="file-card-stat" style={{ color: "var(--red)" }}>{f.claimed} taken</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* download history */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Recent downloads</div>
        {!downloads || downloads.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>{downloads === null ? "Loading..." : "No downloads yet"}</div>
        ) : (
          <div className="card-list">
            {(downloads as unknown as { id: string; at: number; ts?: number; poolId: string; password: string; claimed: number; filename: string; reverted?: boolean; claimedBy?: string | null }[]).map((d) => {
              const dt = d.at || (d as unknown as { ts?: number }).ts ? new Date((d.at ?? (d as unknown as { ts: number }).ts)) : null;
              const dateStr = dt ? dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
              const timeStr = dt ? dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
              const isReverted = !!(d as unknown as { reverted?: boolean }).reverted;
              const poolLabel = d.poolId || (d.filename?.includes("page_") ? "page" : d.filename?.includes("2fa") ? "cookies_2fa" : "cookies_only");
              const poolBadgeClass = poolLabel === "page" ? "badge page" : "badge";
              const claimer = d.claimedBy ? adminMap.get(String(d.claimedBy)) : null;
              const initials = claimer?.name?.charAt(0)?.toUpperCase() || (d.claimedBy ? String(d.claimedBy).charAt(0).toUpperCase() : "");
              return (
                <div
                  key={d.id}
                  className={`pool-card dl-card ${isReverted ? "reverted" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`View download ${d.filename}`}
                  onClick={() => setDetailId(d.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailId(d.id); } }}
                  style={{ cursor: "pointer" }}
                >
                  {(() => { const meta = POOL_META[poolLabel] ?? POOL_META.cookies_only; const PoolIcon = meta.Icon; return (
                  <span className={poolBadgeClass} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5 }}><PoolIcon size={12} />{meta.label}</span>
                  ); })()}
                  <span title={claimer?.name ?? (d.claimedBy ? String(d.claimedBy) : "Claimer unknown — before tracking")} style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", display: "grid", placeItems: "center", background: "var(--bg3)", border: "1.5px solid var(--border)", flexShrink: 0, color: "var(--text2)" }}>
                    {claimer?.photoUrl ? <img src={claimer.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initials ? <span style={{ fontWeight: 700, fontSize: 14 }}>{initials}</span> : <UnknownUserIcon size={16} />}
                  </span>
                  <div className="pool-card-info">
                    <div className="pool-card-name" title={d.filename}>{d.filename}</div>
                    <div className="pool-card-sub">
                      <span title={d.at ? new Date(d.at).toISOString() : ""}>{dateStr} {timeStr}</span>
                      <span>·</span>
                      <span>{d.claimed} claimed</span>
                      {claimer?.name ? <><span>·</span><span title={String(d.claimedBy)} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{claimer.name}</span></> : d.claimedBy ? <><span>·</span><span title={String(d.claimedBy)}>#{String(d.claimedBy).slice(-6)}</span></> : null}
                      {isReverted ? <><span>·</span><span style={{ color: "var(--green)", fontWeight: 600 }}>REVERTED</span></> : null}
                    </div>
                  </div>
                  <div className="pool-card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <button className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={reDownloading === d.id || isReverted} onClick={() => doRedownload(d.id, d.filename)}>{reDownloading === d.id ? "…" : "Download"}</button>
                    <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, color: isReverted ? "var(--text3)" : "var(--red)" }} disabled={reverting === d.id || isReverted} onClick={() => doRevert(d.id)}>{reverting === d.id ? "…" : isReverted ? "Returned" : "Return"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dlUser ? (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setDlUser(null); }}>
          <div className="modal-box" role="dialog" aria-modal="true" style={{ width: 360 }}>
            <div className="modal-title">Download</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>{displayName(dlUser).line1} &middot; {dlUser.available} available</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {[10, 50].map((n) => <button key={n} className={`btn ${perQty === n && !perCustom ? "btn-primary" : ""}`} onClick={() => { setPerQty(n); setPerCustom(""); }}>{n}</button>)}
              <button className={`btn ${perQty === "all" && !perCustom ? "btn-primary" : ""}`} onClick={() => { setPerQty("all"); setPerCustom(""); }}>All</button>
              <input
                placeholder={perCustomFocused ? "" : "Custom"}
                aria-label="Custom quantity"
                value={perCustom}
                onChange={(e) => setPerCustom(e.target.value.replace(/\D/g, ""))}
                onFocus={(e) => { setPerCustomFocused(true); e.currentTarget.select(); }}
                onBlur={() => setPerCustomFocused(false)}
                style={{ width: 72, padding: "6px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: "var(--r)", outline: "none", textAlign: "center", cursor: perCustom || perCustomFocused ? "text" : "pointer", background: perCustom ? "var(--bg3)" : "var(--bg)" }}
              />
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>Claiming {perCustom ? Number(perCustom) || 0 : perQty === "all" ? dlUser.available : perQty as number} of {dlUser.available} available</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDlUser(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={downloading} onClick={doUserClaim}>Download & claim</button>
            </div>
          </div>
        </div>
      ) : null}
      <DownloadDetailModal downloadId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

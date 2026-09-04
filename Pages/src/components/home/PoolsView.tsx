import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import type { PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { useProfileCache } from "@/stores/profileCache";
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
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 145" aria-hidden="true" {...props}>
    <title>soundcloud</title>
    <defs>
      <linearGradient id="PVEm" x1="49.719%" x2="49.719%" y1="-27.701%" y2="100.084%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVIj" x1="50.208%" x2="50.208%" y1="-25%" y2="100.195%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVF3" x1="50.031%" x2="50.031%" y1="-26.166%" y2="100.311%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVJ1" x1="49.936%" x2="49.936%" y1="-23.196%" y2="100.193%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVu9" x1="49.525%" x2="49.525%" y1="-89.845%" y2="101.504%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVlH" x1="50.151%" x2="50.151%" y1="-13.846%" y2="100.179%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVcG" x1="49.659%" x2="49.659%" y1="-95.238%" y2="100.836%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PV9b" x1="49.596%" x2="49.596%" y1="-51.09%" y2="100.373%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVb7" x1="50.414%" x2="50.414%" y1="-33.211%" y2="100.08%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVwO" x1="50.034%" x2="50.034%" y1="-7.143%" y2="100.168%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVOb" x1="50.325%" x2="50.325%" y1="-220.199%" y2="147.927%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVKp" x1="49.159%" x2="49.159%" y1="-121.474%" y2="112.576%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVg3" x1="50.422%" x2="50.422%" y1="-94.484%" y2="103.334%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="PVfg" x1="49.931%" x2="49.931%" y1="0%" y2="100.017%"><stop offset="0%" stop-color="#f7941e"/><stop offset="0%" stop-color="#f68b1f"/><stop offset="0%" stop-color="#f6871f"/><stop offset="24.02%" stop-color="#f57e20"/><stop offset="63.06%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
    </defs>
    <path fill="url(#PVEm)" d="m109.97 81.482l-1.494-54.487c0-1.694-1.394-2.989-2.988-2.989c-1.693 0-2.988 1.295-2.988 2.989l-1.395 54.487l1.395 26.197c0 1.694 1.394 2.989 2.988 2.989c1.693 0 2.988-1.295 2.988-2.989z" />
    <path fill="url(#PVIj)" d="m99.212 81.482l-1.693-56.58a2.784 2.784 0 0 0-2.789-2.788a2.784 2.784 0 0 0-2.79 2.789l-1.493 56.48l1.494 26.396a2.784 2.784 0 0 0 2.789 2.79a2.784 2.784 0 0 0 2.79-2.79z" />
    <path fill="url(#PVF3)" d="M76.003 25.301c-.1-1.295-1.096-2.39-2.39-2.39s-2.292.996-2.391 2.39l-1.694 56.081l1.694 26.795c0 1.295 1.096 2.291 2.39 2.291s2.292-.996 2.391-2.39l1.992-26.796z" />
    <path fill="url(#PVJ1)" d="M86.761 23.409c0-1.395-1.195-2.59-2.59-2.59a2.57 2.57 0 0 0-2.59 2.59l-1.593 57.973l1.593 26.596c0 1.395 1.196 2.59 2.59 2.59c1.395 0 2.49-1.096 2.59-2.59l1.793-26.596z" />
    <path fill="url(#PVu9)" d="M32.473 109.87c.797 0 1.395-.597 1.494-1.493l2.59-26.995l-2.59-27.89c-.1-.798-.697-1.495-1.494-1.495s-1.394.598-1.494 1.494l-2.291 27.891l2.291 26.995c0 .896.697 1.494 1.494 1.494" />
    <path fill="url(#PVlH)" d="m120.828 81.482l-1.395-64.747c0-1.096-.597-2.092-1.494-2.69c-.498-.299-1.095-.598-1.793-.598c-.597 0-1.195.2-1.793.499c-.896.597-1.494 1.593-1.494 2.689v.598l-1.195 64.15l1.195 25.998v.1c0 .696.299 1.394.797 1.892c.598.697 1.494 1.195 2.49 1.195c.897 0 1.694-.398 2.291-.896c.598-.598.996-1.395.996-2.291l.1-2.59z" />
    <path fill="url(#PVcG)" d="M44.327 55.483c-.1-.996-.797-1.693-1.694-1.693s-1.693.697-1.693 1.693l-2.092 25.9l2.092 27.193c.1.996.797 1.693 1.693 1.693c.897 0 1.694-.697 1.694-1.693l2.39-27.194z" />
    <path fill="url(#PV9b)" d="M52.893 37.354c-.996 0-1.892.797-1.892 1.893l-1.992 42.135L51 108.576c.1 1.096.896 1.892 1.892 1.892s1.893-.796 1.893-1.892l2.291-27.194l-2.291-42.135c0-.996-.897-1.893-1.893-1.893" />
    <path fill="url(#PVb7)" d="m65.245 108.576l2.092-27.094l-2.092-51.798c-.1-1.195-.996-2.092-2.191-2.092c-1.196 0-2.092.897-2.192 2.092L58.97 81.482l1.892 27.094c0 1.195.996 2.092 2.192 2.092c1.195.1 2.092-.897 2.191-2.092" />
    <path fill="url(#PVwO)" d="M128.697 7.87a3.44 3.44 0 0 0-1.793-.499a3.48 3.48 0 0 0-2.191.797c-.797.598-1.295 1.594-1.295 2.69v.398l-1.395 70.325l.698 12.95l.697 12.65c0 1.893 1.594 3.387 3.486 3.387s3.387-1.594 3.487-3.486l1.494-25.6l-1.494-70.624c-.1-1.295-.698-2.391-1.694-2.989" />
    <path fill="url(#PVOb)" d="M2.889 96.324c.498 0 .896-.399.996-.996l2.191-13.946l-2.191-14.145c-.1-.597-.498-.996-.996-.996a1 1 0 0 0-.996.996L0 81.382l1.893 13.946c0 .597.498.996.996.996" />
    <path fill="url(#PVKp)" d="M12.352 104.79c.498 0 .996-.398 1.095-.995l2.89-22.413l-2.89-22.91c-.1-.598-.498-.997-1.095-.997c-.498 0-.996.399-1.096.997l-2.49 22.91l2.49 22.413c.1.597.498.996 1.096.996" />
    <path fill="url(#PVg3)" d="M22.313 108.875c.697 0 1.195-.498 1.295-1.295l2.69-26.198l-2.69-27.194c-.1-.697-.598-1.295-1.295-1.295s-1.195.498-1.295 1.295l-2.39 27.194l2.39 26.198c.1.697.598 1.295 1.295 1.295" />
    <path fill="url(#PVfg)" d="M223.626 48.012c-4.283 0-8.367.897-12.152 2.391C208.984 22.213 185.276 0 156.389 0a55.1 55.1 0 0 0-20.022 3.785c-2.39.897-2.988 1.893-2.988 3.686v99.511c0 1.893 1.494 3.387 3.387 3.586h86.96c17.332 0 31.378-13.846 31.378-31.178c-.1-17.332-14.145-31.378-31.478-31.378" />
  </svg>
);

const PasswordIcon = ({ password, size = 14 }: { password: string; size?: number }) => password === "dgddigital" ? (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0" />
    <path d="M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6" />
    <path d="M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6" />
    <circle cx="12" cy="12" r="10" />
  </svg>
) : password === "L0VE@12345" ? (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
    <title>lovable</title>
    <ellipse cx="52.738" cy="65.101" fill="#4b73ff" rx="81.373" ry="81.192" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="61.673" cy="20.547" fill="#ff66f4" rx="104.216" ry="81.192" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="78.666" cy="5.268" fill="#ff0105" rx="81.373" ry="71.304" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="63.121" cy="20.527" fill="#fe7b02" rx="48.937" ry="48.829" transform="translate(.92)scale(1.04949)" />
    <defs>
      <mask id="pmask"><path fill="white" fillRule="evenodd" d="M38.774 0C59.68 0 76.628 16.955 76.628 37.87v14.392h12.598c20.905 0 37.854 16.955 37.854 37.87c0 20.913-16.949 37.868-37.854 37.868H.92V37.87C.92 16.954 17.868 0 38.774 0" /></mask>
    </defs>
  </svg>
) : null;

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
  const { profiles: cachedProfiles, fetchProfiles } = useProfileCache();
  const adminMap = useMemo(() => {
    const m = new Map<string, { name: string; username?: string; photoUrl?: string | null }>();
    for (const [k, v] of Object.entries(cachedProfiles)) m.set(k, { name: v.name, username: v.username ?? undefined, photoUrl: v.photoUrl ?? null });
    return m;
  }, [cachedProfiles]);
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
      try { useProfileCache.getState().setProfiles(d.users as unknown[]); } catch {}
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

  // claimer avatars — cached globally so pool/admin switches don't refetch
  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

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
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px;display:inline-flex;align-items:center;gap:6px}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);box-shadow:none;filter:none}
        .badge.page{background:#fffbeb;color:#b45309;border-color:#fde68a;box-shadow:none;filter:none}
        .badge.taken{background:var(--bg3);color:var(--text3)}
        .admin-wrap{position:relative;display:inline-flex;flex-shrink:0}
        .admin-dot{position:absolute;right:-4px;bottom:-4px;width:18px;height:18px;display:grid;place-items:center;color:#1d9bf0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.15));background:transparent;border:none;}
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
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}><PasswordIcon password={p} size={14} />{p}</button>
            ))}
          </div>
          <div className="pool-switch">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              const Icon = meta.Icon;
              return (
                <button key={t.id} className={cur === t.id ? "active" : ""} onClick={() => go(curPwd, t.id)}>
                  <Icon size={14} />{t.label} <span className="badge" style={{ marginLeft: 2 }}>{poolCounts[t.id] ?? 0}</span>
                </button>
              );
            })}
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
                  {isAdmin ? <span className="admin-dot" aria-label="Verified admin" title="Verified"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.418 5.643a1.25 1.25 0 0 0-1.34-.555l-1.798.413a1.25 1.25 0 0 1-.56 0l-1.798-.413a1.25 1.25 0 0 0-1.34.555l-.98 1.564c-.1.16-.235.295-.395.396l-1.564.98a1.25 1.25 0 0 0-.555 1.338l.413 1.8a1.25 1.25 0 0 1 0 .559l-.413 1.799a1.25 1.25 0 0 0 .555 1.339l1.564.98c.16.1.295.235.396.395l.98 1.564c.282.451.82.674 1.339.555l1.798-.413a1.25 1.25 0 0 1 .56 0l1.799.413a1.25 1.25 0 0 0 1.339-.555l.98-1.564c.1-.16.235-.295.395-.395l1.565-.98a1.25 1.25 0 0 0 .554-1.34L18.5 12.28a1.25 1.25 0 0 1 0-.56l.413-1.799a1.25 1.25 0 0 0-.554-1.339l-1.565-.98a1.25 1.25 0 0 1-.395-.395z"/><path fill="#fff" d="M14.915 9.77a.5.5 0 0 0-.86-.509l-2.615 4.426l-1.579-1.512a.5.5 0 1 0-.691.722l2.034 1.949a.5.5 0 0 0 .776-.107z"/></svg></span> : null}
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

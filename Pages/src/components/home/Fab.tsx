import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { FacebookIcon } from "@/components/icons/FacebookIcon";
import type { FilePreset } from "@/lib/types";

const TwoFaIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 -11 960 876" width={size} height={size} aria-hidden="true" {...props}>
    <path d="M960 427c0 44.7-36.2 80.9-80.9 80.9H600L480 265.2 609.5 40.9C631.9 2.2 681.3-11 720 11.3c38.7 22.4 51.9 71.8 29.6 110.5L620.1 346.1h259c44.7 0 80.9 36.2 80.9 80.9z" fill="#1a73e8" />
    <path d="M720 842.7c-38.7 22.3-88.1 9.1-110.5-29.6L480 588.8 350.5 813.1c-22.4 38.7-71.8 51.9-110.5 29.6-38.7-22.4-51.9-71.8-29.6-110.5l129.5-224.3 140.1-5.3 140.1 5.3 129.5 224.3c22.3 38.7 9.1 88.1-29.6 110.5z" fill="#ea4335" />
    <path d="M480 265.2l-36.5 99.2-103.6-18.3-129.5-224.3c-22.3-38.7-9.1-88.1 29.6-110.5 38.7-22.3 88.1-9.1 110.5 29.6z" fill="#fbbc04" />
    <path d="M459.1 346.1l-93.9 161.8H80.9C36.2 507.9 0 471.7 0 427s36.2-80.9 80.9-80.9z" fill="#34a853" />
    <path d="M620.1 507.9H339.9L480 265.2z" fill="#185db7" />
  </svg>
);

const PageIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 145" aria-hidden="true" {...props}>
    <title>soundcloud</title>
    <defs>
      <linearGradient id="SVGIEmVCpML" x1="49.719%" x2="49.719%" y1="-27.701%" y2="100.084%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGIIjM9bTC" x1="50.208%" x2="50.208%" y1="-25%" y2="100.195%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGF3QSzdGG" x1="50.031%" x2="50.031%" y1="-26.166%" y2="100.311%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGJ1RW7w6r" x1="49.936%" x2="49.936%" y1="-23.196%" y2="100.193%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGu9d1hc3n" x1="49.525%" x2="49.525%" y1="-89.845%" y2="101.504%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGlHACbbSr" x1="50.151%" x2="50.151%" y1="-13.846%" y2="100.179%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGcGJADgJy" x1="49.659%" x2="49.659%" y1="-95.238%" y2="100.836%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVG9baP6uNn" x1="49.596%" x2="49.596%" y1="-51.09%" y2="100.373%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGb7UCDQhf" x1="50.414%" x2="50.414%" y1="-33.211%" y2="100.08%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGwOgLAdLn" x1="50.034%" x2="50.034%" y1="-7.143%" y2="100.168%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGObJeiunq" x1="50.325%" x2="50.325%" y1="-220.199%" y2="147.927%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGKpbWAdRP" x1="49.159%" x2="49.159%" y1="-121.474%" y2="112.576%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGg3vbGcNQ" x1="50.422%" x2="50.422%" y1="-94.484%" y2="103.334%"><stop offset="0%" stop-color="#f6871f"/><stop offset="23.93%" stop-color="#f57e20"/><stop offset="62.62%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
      <linearGradient id="SVGfgvSneKT" x1="49.931%" x2="49.931%" y1="0%" y2="100.017%"><stop offset="0%" stop-color="#f7941e"/><stop offset="0%" stop-color="#f68b1f"/><stop offset="0%" stop-color="#f6871f"/><stop offset="24.02%" stop-color="#f57e20"/><stop offset="63.06%" stop-color="#f36621"/><stop offset="100%" stop-color="#f04923"/></linearGradient>
    </defs>
    <path fill="url(#SVGIEmVCpML)" d="m109.97 81.482l-1.494-54.487c0-1.694-1.394-2.989-2.988-2.989c-1.693 0-2.988 1.295-2.988 2.989l-1.395 54.487l1.395 26.197c0 1.694 1.394 2.989 2.988 2.989c1.693 0 2.988-1.295 2.988-2.989z" />
    <path fill="url(#SVGIIjM9bTC)" d="m99.212 81.482l-1.693-56.58a2.784 2.784 0 0 0-2.789-2.788a2.784 2.784 0 0 0-2.79 2.789l-1.493 56.48l1.494 26.396a2.784 2.784 0 0 0 2.789 2.79a2.784 2.784 0 0 0 2.79-2.79z" />
    <path fill="url(#SVGF3QSzdGG)" d="M76.003 25.301c-.1-1.295-1.096-2.39-2.39-2.39s-2.292.996-2.391 2.39l-1.694 56.081l1.694 26.795c0 1.295 1.096 2.291 2.39 2.291s2.292-.996 2.391-2.39l1.992-26.796z" />
    <path fill="url(#SVGJ1RW7w6r)" d="M86.761 23.409c0-1.395-1.195-2.59-2.59-2.59a2.57 2.57 0 0 0-2.59 2.59l-1.593 57.973l1.593 26.596c0 1.395 1.196 2.59 2.59 2.59c1.395 0 2.49-1.096 2.59-2.59l1.793-26.596z" />
    <path fill="url(#SVGu9d1hc3n)" d="M32.473 109.87c.797 0 1.395-.597 1.494-1.493l2.59-26.995l-2.59-27.89c-.1-.798-.697-1.495-1.494-1.495s-1.394.598-1.494 1.494l-2.291 27.891l2.291 26.995c0 .896.697 1.494 1.494 1.494" />
    <path fill="url(#SVGlHACbbSr)" d="m120.828 81.482l-1.395-64.747c0-1.096-.597-2.092-1.494-2.69c-.498-.299-1.095-.598-1.793-.598c-.597 0-1.195.2-1.793.499c-.896.597-1.494 1.593-1.494 2.689v.598l-1.195 64.15l1.195 25.998v.1c0 .696.299 1.394.797 1.892c.598.697 1.494 1.195 2.49 1.195c.897 0 1.694-.398 2.291-.896c.598-.598.996-1.395.996-2.291l.1-2.59z" />
    <path fill="url(#SVGcGJADgJy)" d="M44.327 55.483c-.1-.996-.797-1.693-1.694-1.693s-1.693.697-1.693 1.693l-2.092 25.9l2.092 27.193c.1.996.797 1.693 1.693 1.693c.897 0 1.694-.697 1.694-1.693l2.39-27.194z" />
    <path fill="url(#SVG9baP6uNn)" d="M52.893 37.354c-.996 0-1.892.797-1.892 1.893l-1.992 42.135L51 108.576c.1 1.096.896 1.892 1.892 1.892s1.893-.796 1.893-1.892l2.291-27.194l-2.291-42.135c0-.996-.897-1.893-1.893-1.893" />
    <path fill="url(#SVGb7UCDQhf)" d="m65.245 108.576l2.092-27.094l-2.092-51.798c-.1-1.195-.996-2.092-2.191-2.092c-1.196 0-2.092.897-2.192 2.092L58.97 81.482l1.892 27.094c0 1.195.996 2.092 2.192 2.092c1.195.1 2.092-.897 2.191-2.092" />
    <path fill="url(#SVGwOgLAdLn)" d="M128.697 7.87a3.44 3.44 0 0 0-1.793-.499a3.48 3.48 0 0 0-2.191.797c-.797.598-1.295 1.594-1.295 2.69v.398l-1.395 70.325l.698 12.95l.697 12.65c0 1.893 1.594 3.387 3.486 3.387s3.387-1.594 3.487-3.486l1.494-25.6l-1.494-70.624c-.1-1.295-.698-2.391-1.694-2.989" />
    <path fill="url(#SVGObJeiunq)" d="M2.889 96.324c.498 0 .896-.399.996-.996l2.191-13.946l-2.191-14.145c-.1-.597-.498-.996-.996-.996a1 1 0 0 0-.996.996L0 81.382l1.893 13.946c0 .597.498.996.996.996" />
    <path fill="url(#SVGKpbWAdRP)" d="M12.352 104.79c.498 0 .996-.398 1.095-.995l2.89-22.413l-2.89-22.91c-.1-.598-.498-.997-1.095-.997c-.498 0-.996.399-1.096.997l-2.49 22.91l2.49 22.413c.1.597.498.996 1.096.996" />
    <path fill="url(#SVGg3vbGcNQ)" d="M22.313 108.875c.697 0 1.195-.498 1.295-1.295l2.69-26.198l-2.69-27.194c-.1-.697-.598-1.295-1.295-1.295s-1.195.498-1.295 1.295l-2.39 27.194l2.39 26.198c.1.697.598 1.295 1.295 1.295" />
    <path fill="url(#SVGfgvSneKT)" d="M223.626 48.012c-4.283 0-8.367.897-12.152 2.391C208.984 22.213 185.276 0 156.389 0a55.1 55.1 0 0 0-20.022 3.785c-2.39.897-2.988 1.893-2.988 3.686v99.511c0 1.893 1.494 3.387 3.387 3.586h86.96c17.332 0 31.378-13.846 31.378-31.178c-.1-17.332-14.145-31.378-31.478-31.378" />
  </svg>
);

const CookieIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
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

const Doc2xIcon = ({ size = 24, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <title>doc2x</title>
    <path fill="#7748f9" d="M21.66 7.017a3.308 3.308 0 1 0-4.677-4.678l-3.458 3.458a3.308 3.308 0 1 0 4.678 4.677l3.458-3.457zM10.475 18.203a3.308 3.308 0 1 0-4.678-4.678l-3.458 3.458a3.308 3.308 0 1 0 4.678 4.677z" />
    <path fill="#bfabfb" d="M18.203 13.525a3.308 3.308 0 1 0-4.678 4.678l3.458 3.458a3.308 3.308 0 0 0 4.678-4.678zM7.017 2.339a3.308 3.308 0 1 0-4.678 4.678l3.458 3.457a3.308 3.308 0 0 0 4.677-4.678z" />
  </svg>
);

interface FabProps {
  onCreate: (preset: FilePreset) => void;
  onUpload: (file: File) => void;
}

export default function Fab({ onCreate, onUpload }: FabProps) {
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(t) &&
        fabRef.current &&
        !fabRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const handleUploadClick = () => {
    setOpen(false);
    fileRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) onUpload(file);
  };

  return (
    <>
      <button
        ref={fabRef}
        className="home-fab"
        aria-label="Create file"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Doc2xIcon size={24} />
      </button>
      <div ref={menuRef} className={`home-fab-menu${open ? " open" : ""}`}>
        <div className="home-fab-platform" style={{ display: "flex", alignItems: "center", gap: 6 }}><FacebookIcon size={13} />Facebook</div>
        {([
          ["cookie", "Cookie", "cookies and uid", CookieIcon],
          ["combo", "2fa", "cookies and 2fa and uid", TwoFaIcon],
          ["page", "Page", "full columns", PageIcon],
        ] as const).map(([preset, name, desc, Icon]) => (
          <button className="home-fab-item home-fab-subitem" key={preset} onClick={() => { setOpen(false); onCreate(preset); }}>
            <span className="home-fab-ic" style={{ background: "var(--bg3)", color: "var(--text)" }}><Icon size={15} /></span>
            <span>
              <span className="home-fab-name">{name}</span>
              <span className="home-fab-desc">{desc}</span>
            </span>
          </button>
        ))}
        <div className="home-fab-sep"></div>
        <button className="home-fab-item" onClick={handleUploadClick}>
          <span className="home-fab-ic" style={{ background: "var(--bg3)", color: "var(--text2)" }}>
            <Upload size={15} />
          </span>
          <span>
            <span className="home-fab-name">Upload xlsx</span>
            <span className="home-fab-desc">Import data from file</span>
          </span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </>
  );
}

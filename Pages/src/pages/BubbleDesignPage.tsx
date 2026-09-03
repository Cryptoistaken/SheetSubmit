import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useToast } from "@/lib/toast";

type IconId = "claude" | "claudeCode" | "claudeCodePlayful" | "pacman" | "logo" | "appIcon";
interface BubbleCfg { icon: IconId; color: string; size: number; x: number | null; y: number | null; }

const ICON_TRUE: Record<IconId,string> = { logo:"#111111", appIcon:"#111111", claude:"#DE886D", pacman:"#eab308", claudeCode:"#DE886D", claudeCodePlayful:"#DE886D" };
const DEFAULT: BubbleCfg = { icon: "claudeCodePlayful", color: "#DE886D", size: 60, x: null, y: null };
const COLORS = [
  "#ef4444", // red-500 — DEFAULT
  "#f97316", // orange-500
  "#f59e0b", // amber-500
  "#ca8a04", // yellow-600
  "#65a30d", // lime-600
  "#16a34a", // green-600
  "#059669", // emerald-600
  "#0d9488", // teal-600
  "#0891b2", // cyan-600
  "#0284c7", // sky-600
  "#0070f3", // vercel blue
  "#4f46e5", // indigo-600
  "#7c3aed", // violet-600
  "#9333ea", // purple-600
  "#c026d3", // fuchsia-600
  "#db2777", // pink-600
  "#e11d48", // rose-600
  "#1e293b", // slate-800
  "#92400e", // amber-800
  "#0f766e", // teal-800
  "#1d4ed8", // blue-700
  "#be185d", // rose-700
  "#eab308", // yellow-500 — +7 to reach 29, fills 3rd row
  "#84cc16", // lime-500
  "#22d3ee", // cyan-400
  "#a3e635", // lime-400
  "#fb7185", // rose-400
  "#f43f5e", // rose-500
  "#DE886D", // Claude default peach — body fill
];

const ICON_CLAUDE = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" rx="230" fill="currentColor"/><g fill="#111111"><rect x="250" y="350" width="120" height="240" rx="20"/><rect x="650" y="350" width="120" height="240" rx="20"/></g><g fill="#FFFFFF"><rect x="270" y="380" width="40" height="60" rx="10"/><rect x="670" y="380" width="40" height="60" rx="10"/></g><path d="M -50 600 L 150 600 L 150 800 L -50 800 Z" fill="#C46044"/><path d="M 874 600 L 1074 600 L 1074 800 L 874 800 Z" fill="#C46044"/></svg>`;
const ICON_PACMAN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="100%" height="100%"><path fill="currentColor" d="M 150,150 L 236.6,100 A 100 100 0 1 0 236.6,200 Z"/><circle cx="180" cy="110" r="12" fill="#000"/><circle cx="183" cy="106" r="3.5" fill="#fff" opacity="0.9"/></svg>`;
const ICON_LOGO = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/><path d="M7 8h10M7 12h10M7 16h7" stroke="white" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_APP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="100%" height="100%"><image href="/app-icon.webp" x="0" y="0" width="300" height="300" preserveAspectRatio="xMidYMid meet"/></svg>`;
const ICONS: Record<string,string> = { claude: ICON_CLAUDE, pacman: ICON_PACMAN, logo: ICON_LOGO, appIcon: ICON_APP };
const CLAUDE_PLAYFUL_SVG=`<svg style="display:block" xmlns="http://www.w3.org/2000/svg" viewBox="-5 -2 24 20" width="100%" height="100%" shape-rendering="crispEdges"><defs><style>.shadow-sway{transform-box:fill-box;transform-origin:50% 50%;animation:shadow-sway 1.6s infinite ease-in-out}.body-sway{transform-origin:7.5px 13px;animation:body-sway 1.6s infinite ease-in-out}.leg-left-inner,.leg-left-outer,.leg-right-inner,.leg-right-outer{transform-box:fill-box;transform-origin:50% 0%}.leg-left-inner{animation:leg-left-inner 1.6s infinite ease-in-out}.leg-left-outer{animation:leg-left-outer 1.6s infinite ease-in-out}.leg-right-inner{animation:leg-right-inner 1.6s infinite ease-in-out}.leg-right-outer{animation:leg-right-outer 1.6s infinite ease-in-out}.arm-left-dance{transform-box:fill-box;transform-origin:100% 0%;animation:arm-left-dance 1.6s infinite ease-in-out}.arm-right-dance{transform-box:fill-box;transform-origin:0% 0%;animation:arm-right-dance 1.6s infinite ease-in-out}.earcup-left{transform-box:fill-box;transform-origin:100% 50%;animation:earcup-squeeze 1.6s infinite ease-in-out}.earcup-right{transform-box:fill-box;transform-origin:0% 50%;animation:earcup-squeeze 1.6s infinite ease-in-out}.note-left{animation:note-left 1.6s infinite ease-out}.note-right{animation:note-right 1.6s infinite ease-out}@keyframes shadow-sway{0%,100%{transform:translateX(0) scaleX(1);opacity:0.5}22%,30%{transform:translateX(-0.5px) scaleX(0.85);opacity:0.45}50%{transform:translateX(0) scaleX(1);opacity:0.5}70%,78%{transform:translateX(0.5px) scaleX(0.85);opacity:0.45}}@keyframes body-sway{0%,100%{transform:rotate(0deg) translateY(0)}22%,30%{transform:rotate(-6deg) translateY(0.3px)}50%{transform:rotate(0deg) translateY(-0.2px)}70%,78%{transform:rotate(6deg) translateY(0.3px)}}@keyframes leg-right-inner{0%,100%{transform:rotate(0deg) translateY(0)}22%,30%{transform:rotate(-12deg) translateY(-0.2px)}50%,70%,78%{transform:rotate(0deg) translateY(0)}}@keyframes leg-right-outer{0%,100%{transform:rotate(0deg) translateY(0)}22%,30%{transform:rotate(-22deg) translateY(-0.3px)}50%,70%,78%{transform:rotate(0deg) translateY(0)}}@keyframes leg-left-inner{0%,22%,30%,50%,100%{transform:rotate(0deg) translateY(0)}70%,78%{transform:rotate(12deg) translateY(-0.2px)}}@keyframes leg-left-outer{0%,22%,30%,50%,100%{transform:rotate(0deg) translateY(0)}70%,78%{transform:rotate(22deg) translateY(-0.3px)}}@keyframes arm-left-dance{0%,100%{transform:rotate(0deg)}22%,30%{transform:rotate(-30deg)}50%{transform:rotate(0deg)}70%,78%{transform:rotate(20deg)}}@keyframes arm-right-dance{0%,100%{transform:rotate(0deg)}22%,30%{transform:rotate(-20deg)}50%{transform:rotate(0deg)}70%,78%{transform:rotate(30deg)}}@keyframes earcup-squeeze{0%,100%{transform:scaleX(1)}22%,30%{transform:scaleX(0.85)}50%{transform:scaleX(1.02)}70%,78%{transform:scaleX(0.85)}}@keyframes note-left{0%,14%,42%,100%{opacity:0;transform:translate(0,0)}22%{opacity:1;transform:translate(-0.4px,-1.2px)}38%{opacity:0;transform:translate(-1.6px,-3.5px)}}@keyframes note-right{0%,62%,82%,100%{opacity:0;transform:translate(0,0)}70%{opacity:1;transform:translate(0.4px,-1.2px)}78%{opacity:0;transform:translate(1.6px,-3.5px)}}</style><g id="music-noteB" fill="#FFE066"><rect x="0" y="2" width="1" height="1"/><rect x="1" y="0" width="1" height="3"/><rect x="2" y="0" width="1" height="1"/></g></defs><rect class="shadow-sway" x="3" y="15" width="9" height="1" fill="#000000"/><g fill="#DE886D"><rect class="leg-left-outer" x="3" y="13" width="1" height="2"/><rect class="leg-left-inner" x="5" y="13" width="1" height="2"/><rect class="leg-right-inner" x="9" y="13" width="1" height="2"/><rect class="leg-right-outer" x="11" y="13" width="1" height="2"/></g><g class="body-sway"><rect x="2" y="6" width="11" height="7" fill="#DE886D"/><g fill="#1D5C83"><rect x="4.9" y="2.85" width="5.05" height="0.75"/><rect x="4.46" y="2.93" width="0.75" height="0.75"/><rect x="9.66" y="2.93" width="0.75" height="0.75"/><rect x="4.03" y="3.1" width="0.75" height="0.75"/><rect x="10.11" y="3.09" width="0.75" height="0.75"/><rect x="3.59" y="3.34" width="0.75" height="0.75"/><rect x="10.57" y="3.33" width="0.75" height="0.75"/><rect x="3.15" y="3.63" width="0.75" height="0.75"/><rect x="11.02" y="3.61" width="0.75" height="0.75"/><rect x="2.71" y="3.98" width="0.75" height="0.75"/><rect x="11.48" y="3.96" width="0.75" height="0.75"/><rect x="2.28" y="4.37" width="0.75" height="0.75"/><rect x="11.94" y="4.34" width="0.75" height="0.75"/><rect x="1.84" y="4.82" width="0.75" height="0.75"/><rect x="12.39" y="4.78" width="0.75" height="0.75"/><rect x="1.4" y="5.3" width="0.75" height="0.75"/><rect x="12.85" y="5.25" width="0.75" height="0.75"/></g><g class="earcup-left"><rect x="0.2" y="7" width="0.6" height="2.4" fill="#1D5C83"/><rect x="0.8" y="6.5" width="0.6" height="3.25" fill="#256891"/><rect x="1.4" y="6" width="0.6" height="4.05" fill="#2E7AA8"/></g><g class="earcup-right"><rect x="14.2" y="7" width="0.6" height="2.4" fill="#1D5C83"/><rect x="13.6" y="6.5" width="0.6" height="3.25" fill="#256891"/><rect x="13" y="6" width="0.6" height="4.05" fill="#2E7AA8"/></g><g class="arm-left-dance"><rect x="-1" y="9" width="2" height="2" fill="#DE886D"/></g><g class="arm-right-dance"><rect x="14" y="9" width="2" height="2" fill="#DE886D"/></g><g fill="none" stroke="#000000" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5,8.5 4.5,9.5 5.5,8.5"/><polyline points="9.5,8.5 10.5,9.5 11.5,8.5"/></g></g><g transform="translate(-5 4)"><g class="note-left"><use href="#music-noteB"/></g></g><g transform="translate(15 4)"><g class="note-right"><use href="#music-noteB"/></g></g></svg>`;
const CLAUDE_REG_SVG=`<svg style="display:block" xmlns="http://www.w3.org/2000/svg" viewBox="-5 -2 24 20" width="100%" height="100%">
  <defs>
    <style>
      /* 16-Second Master Sequence for Idle Actions */
      .action-body {
        transform-origin: 7.5px 13px; /* Pivot at the base of the torso */
        animation: action-body 16s infinite ease-in-out;
      }
      
      /* Continuous Subtle Breathing (Syncs exactly 5 times per 16s loop) */
      .breathe-anim {
        transform-origin: 7.5px 13px;
        animation: breathe 3.2s infinite ease-in-out;
      }

      /* Shadow shrinking and shifting matching actions */
      .shadow-anim {
        transform-origin: 7.5px 15.5px;
        animation: shadow-action 16s infinite ease-in-out;
      }

      /* Left Arm (Scratching and Yawn Stretching) */
      .arm-l {
        transform-origin: 1px 10px;
        animation: arm-l-idle 16s infinite ease-in-out;
      }

      /* Right Arm (Yawn Stretching) */
      .arm-r {
        transform-origin: 14px 10px;
        animation: arm-r-idle 16s infinite ease-in-out;
      }

      /* Eye Tracking (Looking around) */
      .eyes-look {
        animation: eye-track 16s infinite ease-in-out;
      }

      /* Occasional Blinks and shutting during Yawn */
      .eyes-blink {
        transform-origin: 7.5px 9px;
        animation: eye-blink 16s infinite linear;
      }

      /* Yawn Mouth Appearance */
      .yawn-mouth {
        transform-origin: 7.5px 11px;
        animation: yawn-mouth-anim 16s infinite ease-in-out;
        opacity: 0;
      }

      /* Tiny tear that appears during the big yawn */
      .yawn-tear {
        animation: tear-fall 16s infinite ease-in-out;
        opacity: 0;
      }

      /* --- Keyframes --- */

      @keyframes breathe {
        0%, 100% { transform: scale(1, 1) translate(0, 0); }
        50% { transform: scale(1.02, 0.98) translate(0, 0.5px); }
      }

      @keyframes action-body {
        0%, 8%, 26%, 38%, 55%, 80%, 100% { transform: scale(1, 1) translate(0, 0); }
        /* Look Right Tilt */
        12%, 22% { transform: scale(1, 1) translate(1px, 0); }
        /* Look Left Tilt */
        42%, 50% { transform: scale(1, 1) translate(-1px, 0); }
        /* Scratching Lean */
        30%, 36% { transform: scale(1, 1) translate(0.5px, 0); } 
        /* Deep Yawn Stretch */
        60% { transform: scale(0.95, 1.05) translate(0px, -1px); } /* Stretch up */
        65% { transform: scale(0.9, 1.1) translate(0px, -2px); }   /* Peak stretch */
        72% { transform: scale(1.05, 0.95) translate(0px, 1px); }  /* Heavy sigh / squash down */
        76% { transform: scale(1, 1) translate(0px, 0px); }        /* Recover */
      }

      @keyframes shadow-action {
        0%, 8%, 26%, 38%, 55%, 80%, 100% { transform: scaleX(1) translate(0, 0); opacity: 0.5; }
        12%, 22% { transform: scaleX(1) translate(1px, 0); opacity: 0.5; }
        42%, 50% { transform: scaleX(1) translate(-1px, 0); opacity: 0.5; }
        30%, 36% { transform: scaleX(1) translate(0.5px, 0); opacity: 0.5; }
        60% { transform: scaleX(0.95) translate(0, 0); opacity: 0.45; }
        65% { transform: scaleX(0.9) translate(0, 0); opacity: 0.4; }
        72% { transform: scaleX(1.05) translate(0, 0); opacity: 0.55; }
        76% { transform: scaleX(1) translate(0, 0); opacity: 0.5; }
      }

      @keyframes eye-track {
        0%, 10%, 25%, 38%, 52%, 58%, 80%, 100% { transform: translate(0px, 0px); }
        12%, 22% { transform: translate(3px, 0px); } /* Look Right */
        42%, 50% { transform: translate(-3px, 0px); } /* Look Left */
        60%, 75% { transform: translate(0px, -1px); } /* Look slightly up during yawn */
      }

      @keyframes eye-blink {
        0%, 3%, 7%, 18%, 22%, 43%, 47%, 56%, 83%, 87%, 100% { transform: scaleY(1); }
        5%, 20%, 45%, 85% { transform: scaleY(0.1); } /* Quick Blinks */
        /* Yawn Closed Eyes */
        60% { transform: scaleY(1); }
        62%, 72% { transform: scaleY(0.1); } /* Eyes completely shut */
        75% { transform: scaleY(1); }
      }

      @keyframes arm-l-idle {
        0%, 28% { transform: translate(0, 0) rotate(0deg); }
        
        /* Occasional Scratching Sequence (Left Arm) */
        30% { transform: translate(1px, -3px) rotate(15deg); }
        31% { transform: translate(1.5px, -4px) rotate(35deg); } /* Up */
        32% { transform: translate(0.5px, -2.5px) rotate(0deg); } /* Down */
        33% { transform: translate(1.5px, -4px) rotate(35deg); }
        34% { transform: translate(0.5px, -2.5px) rotate(0deg); }
        35% { transform: translate(1.5px, -4px) rotate(35deg); }
        36% { transform: translate(0.5px, -2.5px) rotate(0deg); }
        
        38%, 58% { transform: translate(0, 0) rotate(0deg); }
        
        /* Yawn Stretch */
        62% { transform: translate(-1px, -2px) rotate(45deg); }
        65% { transform: translate(-2px, -3px) rotate(80deg); } /* Full outward stretch */
        72% { transform: translate(0px, 1px) rotate(-15deg); } /* Relax down */
        76%, 100% { transform: translate(0, 0) rotate(0deg); }
      }

      @keyframes arm-r-idle {
        0%, 58% { transform: translate(0, 0) rotate(0deg); }
        /* Yawn Stretch */
        62% { transform: translate(1px, -2px) rotate(-45deg); }
        65% { transform: translate(2px, -3px) rotate(-80deg); } /* Full outward stretch */
        72% { transform: translate(0px, 1px) rotate(15deg); } /* Relax down */
        76%, 100% { transform: translate(0, 0) rotate(0deg); }
      }

      @keyframes yawn-mouth-anim {
        0%, 58%, 76%, 100% { opacity: 0; transform: scale(0.1); }
        60% { opacity: 1; transform: scale(0.5, 0.2); }
        65% { opacity: 1; transform: scale(1.1, 1.4); } /* Wide Open */
        72% { opacity: 1; transform: scale(0.6, 0.4); } /* Shrinking */
        75% { opacity: 0; transform: scale(0.1); }
      }

      @keyframes tear-fall {
        0%, 64%, 80%, 100% { opacity: 0; transform: translateY(0); }
        66% { opacity: 1; transform: translateY(0); } /* Appears at corner of eye */
        72% { opacity: 1; transform: translateY(2.5px); } /* Slides down cheek */
        75% { opacity: 0; transform: translateY(3px); } /* Fades out */
      }
    </style>
  </defs>

  <!-- Ground Shadow -->
  <rect id="ground-shadow" class="shadow-anim" x="3" y="15" width="9" height="1" fill="#000000" opacity="0.5"/>

  <!-- Static Character Legs (Planted firmly while the body stretches above) -->
  <g id="legs" fill="#DE886D">
    <rect id="outer-left-leg" x="3" y="13" width="1" height="2"/>
    <rect id="inner-left-leg" x="5" y="13" width="1" height="2"/>
    <rect id="inner-right-leg" x="9" y="13" width="1" height="2"/>
    <rect id="outer-right-leg" x="11" y="13" width="1" height="2"/>
  </g>

  <!-- Animated Upper Body (Combines occasional actions + continuous breathing) -->
  <g class="action-body">
    <g class="breathe-anim">
      
      <!-- Torso -->
      <rect id="torso" x="2" y="6" width="11" height="7" fill="#DE886D"/>
      
      <!-- Arms -->
      <g class="arm-l">
        <rect id="left-arm" x="0" y="9" width="2" height="2" fill="#DE886D"/>
      </g>
      <g class="arm-r">
        <rect id="right-arm" x="13" y="9" width="2" height="2" fill="#DE886D"/>
      </g>

      <!-- Yawning Mouth (Hidden usually) -->
      <rect class="yawn-mouth" x="6" y="10" width="3" height="2" fill="#000000"/>

      <!-- Eyes Group -->
      <g class="eyes-look" fill="#000000">
        <g class="eyes-blink">
          <rect id="left-eye" x="4" y="8" width="1" height="2"/>
          <rect id="right-eye" x="10" y="8" width="1" height="2"/>
        </g>
      </g>

      <!-- Yawn Tear Drop (A tiny detail for the big stretch) -->
      <rect class="yawn-tear" x="3.5" y="10" width="1" height="1" fill="#40C4FF"/>
      
    </g>
  </g>
</svg>`;
// @ts-ignore unused keep for reference
const _CLAUDE_CODE_SVG_UNUSED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 3 16 13" width="100%" height="100%" style="display:block"><defs><style>.action-body{transform-origin:7.5px 13px;animation:action-body 16s infinite ease-in-out}.breathe-anim{transform-origin:7.5px 13px;animation:breathe 3.2s infinite ease-in-out}.shadow-anim{transform-origin:7.5px 15.5px;animation:shadow-action 16s infinite ease-in-out}.arm-l{transform-origin:1px 10px;animation:arm-l-idle 16s infinite ease-in-out}.arm-r{transform-origin:14px 10px;animation:arm-r-idle 16s infinite ease-in-out}.eyes-look{animation:eye-track 16s infinite ease-in-out}.eyes-blink{transform-origin:7.5px 9px;animation:eye-blink 16s infinite linear}.yawn-mouth{transform-origin:7.5px 11px;animation:yawn-mouth-anim 16s infinite ease-in-out;opacity:0}.yawn-tear{animation:tear-fall 16s infinite ease-in-out;opacity:0}@keyframes breathe{0%,100%{transform:scale(1,1) translate(0,0)}50%{transform:scale(1.02,0.98) translate(0,0.5px)}}@keyframes action-body{0%,8%,26%,38%,55%,80%,100%{transform:scale(1,1) translate(0,0)}12%,22%{transform:scale(1,1) translate(1px,0)}42%,50%{transform:scale(1,1) translate(-1px,0)}30%,36%{transform:scale(1,1) translate(0.5px,0)}60%{transform:scale(0.95,1.05) translate(0px,-1px)}65%{transform:scale(0.9,1.1) translate(0px,-2px)}72%{transform:scale(1.05,0.95) translate(0px,1px)}76%{transform:scale(1,1) translate(0px,0px)}}@keyframes shadow-action{0%,8%,26%,38%,55%,80%,100%{transform:scaleX(1) translate(0,0);opacity:0.5}12%,22%{transform:scaleX(1) translate(1px,0);opacity:0.5}42%,50%{transform:scaleX(1) translate(-1px,0);opacity:0.5}30%,36%{transform:scaleX(1) translate(0.5px,0);opacity:0.5}60%{transform:scaleX(0.95) translate(0,0);opacity:0.45}65%{transform:scaleX(0.9) translate(0,0);opacity:0.4}72%{transform:scaleX(1.05) translate(0,0);opacity:0.55}76%{transform:scaleX(1) translate(0,0);opacity:0.5}}@keyframes eye-track{0%,10%,25%,38%,52%,58%,80%,100%{transform:translate(0px,0px)}12%,22%{transform:translate(3px,0px)}42%,50%{transform:translate(-3px,0px)}60%,75%{transform:translate(0px,-1px)}}@keyframes eye-blink{0%,3%,7%,18%,22%,43%,47%,56%,83%,87%,100%{transform:scaleY(1)}5%,20%,45%,85%{transform:scaleY(0.1)}60%{transform:scaleY(1)}62%,72%{transform:scaleY(0.1)}75%{transform:scaleY(1)}}@keyframes arm-l-idle{0%,28%{transform:translate(0,0) rotate(0deg)}30%{transform:translate(1px,-3px) rotate(15deg)}31%{transform:translate(1.5px,-4px) rotate(35deg)}32%{transform:translate(0.5px,-2.5px) rotate(0deg)}33%{transform:translate(1.5px,-4px) rotate(35deg)}34%{transform:translate(0.5px,-2.5px) rotate(0deg)}35%{transform:translate(1.5px,-4px) rotate(35deg)}36%{transform:translate(0.5px,-2.5px) rotate(0deg)}38%,58%{transform:translate(0,0) rotate(0deg)}62%{transform:translate(-1px,-2px) rotate(45deg)}65%{transform:translate(-2px,-3px) rotate(80deg)}72%{transform:translate(0px,1px) rotate(-15deg)}76%,100%{transform:translate(0,0) rotate(0deg)}}@keyframes arm-r-idle{0%,58%{transform:translate(0,0) rotate(0deg)}62%{transform:translate(1px,-2px) rotate(-45deg)}65%{transform:translate(2px,-3px) rotate(-80deg)}72%{transform:translate(0px,1px) rotate(15deg)}76%,100%{transform:translate(0,0) rotate(0deg)}}@keyframes yawn-mouth-anim{0%,58%,76%,100%{opacity:0;transform:scale(0.1)}60%{opacity:1;transform:scale(0.5,0.2)}65%{opacity:1;transform:scale(1.1,1.4)}72%{opacity:1;transform:scale(0.6,0.4)}75%{opacity:0;transform:scale(0.1)}}@keyframes tear-fall{0%,64%,80%,100%{opacity:0;transform:translateY(0)}66%{opacity:1;transform:translateY(0)}72%{opacity:1;transform:translateY(2.5px)}75%{opacity:0;transform:translateY(3px)}}</style></defs><rect class="shadow-anim" x="3" y="15" width="9" height="1" fill="#000000" opacity="0.5"/><g fill="currentColor"><rect x="3" y="13" width="1" height="2"/><rect x="5" y="13" width="1" height="2"/><rect x="9" y="13" width="1" height="2"/><rect x="11" y="13" width="1" height="2"/></g><g class="action-body"><g class="breathe-anim"><rect x="2" y="6" width="11" height="7" fill="currentColor"/><g class="arm-l"><rect x="0" y="9" width="2" height="2" fill="currentColor"/></g><g class="arm-r"><rect x="13" y="9" width="2" height="2" fill="currentColor"/></g><rect class="yawn-mouth" x="6" y="10" width="3" height="2" fill="#000"/><g class="eyes-look" fill="#000"><g class="eyes-blink"><rect x="4" y="8" width="1" height="2"/><rect x="10" y="8" width="1" height="2"/></g></g><rect class="yawn-tear" x="3.5" y="10" width="1" height="1" fill="#40C4FF"/></g></g></svg>`;

interface AndroidBridge2 { getBubbleConfig?:()=>string; setBubbleConfig?:(s:string)=>void; }
function getAndroid2(): AndroidBridge2|null{
  try{return (window as unknown as {Android?:AndroidBridge2}).Android ?? null;}catch{return null;}
}
function loadState(): BubbleCfg{
  try{
    const a=getAndroid2();
    if(a?.getBubbleConfig){
      const raw=a.getBubbleConfig();
      if(raw){ const p=JSON.parse(raw) as BubbleCfg; if(p?.icon && p?.color && p?.size) return {icon:p.icon as IconId, color:p.color, size:p.size, x:p.x??null, y:p.y??null};}
    }
  }catch{}
  try{
    const ls=localStorage.getItem("mock_bubble");
    if(ls){ const p=JSON.parse(ls) as BubbleCfg; if(p?.icon && p?.color && p?.size) return {icon:p.icon as IconId, color:p.color, size:p.size, x:p.x??null, y:p.y??null};}
  }catch{}
  return {...DEFAULT};
}
function persist(s:BubbleCfg){
  try{localStorage.setItem("mock_bubble",JSON.stringify(s));}catch{}
  try{getAndroid2()?.setBubbleConfig?.(JSON.stringify(s));}catch{}
}

export default function BubbleDesignPage(){
  const navigate=useNavigate();
  const showToast=useToast();
  const [state,setState]=useState<BubbleCfg>(()=>loadState());
  const [customOpen,setCustomOpen]=useState(false);
  const [cpText,setCpText]=useState(state.color);
  useEffect(()=>{ setCpText(state.color); },[state.color]);
  const update=(patch:Partial<BubbleCfg>)=>{
    setState(prev=>{ const next={...prev,...patch}; persist(next); return next; });
  };
  const applyCustom=()=>{
    let v=cpText.trim().toLowerCase();
    if(!v.startsWith("#")) v="#"+v;
    if(/^#[0-9a-f]{6}$/.test(v)){ update({color:v}); }
    setCustomOpen(false);
  };
  return (
    <div style={{flex:1,overflowY:"auto",background:"var(--bg)"}}>
      <div style={{maxWidth:960,margin:"0 auto",padding:"24px 24px 96px",width:"100%"}}>
        {/* Header — matches sheet header */}
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
          <button className="btn btn-ghost" aria-label="Back" onClick={()=>{ if(window.history.length>1) navigate(-1); else navigate("/"); }} style={{width:32,height:32,padding:0,justifyContent:"center"}}>
            <span style={{fontSize:18,lineHeight:1}}>‹</span>
          </button>
          <h1 style={{fontSize:16,fontWeight:700,letterSpacing:"-0.02em",color:"var(--text)"}}>Bubble design</h1>
        </div>

        {/* Icon — same card as admin-stat-card / file-card */}
        <div style={{border:"1px solid var(--border)",borderRadius:"var(--rl)",background:"var(--bg)",padding:16,marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",color:"var(--text3)",marginBottom:12}}>Icon</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {([
              {id:"logo" as IconId,label:"Logo"},{id:"appIcon" as IconId,label:"App Icon"},{id:"pacman" as IconId,label:"Pac-Man"},{id:"claude" as IconId,label:"Claude"},{id:"claudeCode" as IconId,label:"Claude Code · Regular"},{id:"claudeCodePlayful" as IconId,label:"Claude Code · Playful"},
            ]).map(m=>(
              <button key={m.id} onClick={()=>update({icon:m.id})} title={m.label} aria-label={m.label}
                style={{
                  width:64,height:64,borderRadius:"var(--r)",border: m.id===state.icon ? "1.5px solid var(--text)" : "1px solid var(--border)",
                  background: m.id===state.icon ? "var(--bg2)" : "var(--bg)", display:"grid",placeItems:"center", cursor:"pointer", transition:"border-color 0.12s, background 0.12s"
                }}>
                <div style={{width:(m.id==="claudeCode"||m.id==="claudeCodePlayful")?40:28,height:(m.id==="claudeCode"||m.id==="claudeCodePlayful")?40:28,color:state.color,display:"grid",placeItems:"center",transform:(m.id==="claudeCode"||m.id==="claudeCodePlayful")?"scale(1.35)":"none",transformOrigin:"center"}} dangerouslySetInnerHTML={{__html: m.id==="claudeCodePlayful" ? CLAUDE_PLAYFUL_SVG : m.id==="claudeCode" ? CLAUDE_REG_SVG : (ICONS[m.id] ?? ICON_CLAUDE)}} />
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:"var(--text3)",marginTop:8}}>Changes apply instantly to the floating bubble if enabled</div>
        </div>

        {/* Color — Vercel minimal, no rounded, 2 lines wrap, bigger */}
        <div style={{border:"1px solid var(--border)",borderRadius:"var(--rl)",background:"var(--bg)",padding:16,marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",color:"var(--text3)",marginBottom:12}}>Color</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(28px, 1fr))",gap:0}}>
            <button aria-label="Custom" title="Custom" onClick={()=>{ setCustomOpen(o=>!o); setCpText(state.color); }}
              style={{height:38,display:"grid",placeItems:"center",background:"var(--bg)",border:"1px solid var(--border)",cursor:"pointer"}}>
              <span style={{width:14,height:14,background:"conic-gradient(from 0deg,#ef4444,#f59e0b,#22c55e,#06b6d4,#8b5cf6,#ef4444)",border:"1px solid rgba(0,0,0,.12)",display:"block"}}/>
            </button>
            <button aria-label="Actual" title={`Actual ${ICON_TRUE[state.icon]}`} onClick={()=>update({color: ICON_TRUE[state.icon]})}
              style={{height:38,display:"grid",placeItems:"center",background:ICON_TRUE[state.icon],border: ICON_TRUE[state.icon].toLowerCase()===state.color.toLowerCase() ? "1.5px solid var(--text)" : "1px solid rgba(0,0,0,0.06)",cursor:"pointer",outline: ICON_TRUE[state.icon].toLowerCase()===state.color.toLowerCase() ? "1px solid var(--text)" : "none",outlineOffset:-2}}>
              <span style={{fontSize:10,fontWeight:800,color:"#fff",textShadow:"0 1px 2px rgba(0,0,0,.6)",lineHeight:1}}>A</span>
            </button>
            {COLORS.map(c=>(
              <button key={c} aria-label={c} title={c} onClick={()=>update({color:c.toLowerCase()})}
                style={{
                  height:38, background:c, cursor:"pointer",
                  border: c.toLowerCase()===state.color.toLowerCase() ? "1.5px solid var(--text)" : "1px solid rgba(0,0,0,0.06)",
                  outline: c.toLowerCase()===state.color.toLowerCase() ? "1px solid var(--text)" : "none", outlineOffset:-2
                }} />
            ))}
          </div>
          {customOpen && (
            <div style={{display:"flex",gap:8,alignItems:"center",marginTop:12}}>
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(cpText) ? cpText.toLowerCase() : state.color} onChange={e=>{ const v=e.target.value.toLowerCase(); setCpText(v); update({color:v}); }} style={{width:40,height:36,padding:3,border:"1px solid var(--border)",borderRadius:"var(--r)",background:"var(--bg)"}}/>
              <input type="text" value={cpText} maxLength={7} spellCheck={false} onChange={e=>{ let v=e.target.value.trim(); if(!v.startsWith("#")) v="#"+v; v=v.toLowerCase(); setCpText(e.target.value); if(/^#[0-9a-f]{6}$/.test(v)){ update({color:v}); } }} placeholder="#ef4444" style={{flex:1,padding:"8px 10px",border:"1px solid var(--border)",borderRadius:"var(--r)",fontSize:13,fontFamily:"var(--mono)",background:"var(--bg)",color:"var(--text)"}}/>
              <button className="btn btn-primary btn-sm" onClick={applyCustom}>Use</button>
            </div>
          )}
        </div>

        {/* Size — same slider style as site */}
        <div style={{border:"1px solid var(--border)",borderRadius:"var(--rl)",background:"var(--bg)",padding:16,marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",color:"var(--text3)",marginBottom:12}}>Size</div>
          <input type="range" min={36} max={84} step={2} value={state.size} onChange={e=>update({size:+e.target.value})} style={{width:"100%",accentColor:"var(--text)"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--text3)",marginTop:8}}><span>Small</span><span style={{color:"var(--text)",fontFamily:"var(--mono)",fontWeight:600}}>{state.size} dp</span><span>Large</span></div>
        </div>

        <div style={{display:"flex",gap:8,marginTop:20}}>
          <button className="btn btn-ghost" style={{flex:1}} onClick={()=>{ const n={...DEFAULT}; setState(n); persist(n); showToast("Reset to default"); }}>Reset</button>
          <button className="btn btn-primary" style={{flex:1}} onClick={()=>{ persist(state); showToast(`Saved — ${state.icon} ${state.color} ${state.size}dp`); }}>Save</button>
        </div>
      </div>
    </div>
  );
}



"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { consumeNextHomeNavigationWithoutAnimation } from "@/components/layout/app-header-logo";

type LoaderPhase = "intro" | "reveal" | "move" | "settled";

type MarkMetrics = {
  startCollapsedX: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  startCollapsedWidth: number;
  startWidth: number;
  targetWidth: number;
  startFontSize: number;
  targetFontSize: number;
  startLineHeight: number;
  targetLineHeight: number;
  startLetterSpacing: number;
  targetLetterSpacing: number;
  startGap: number;
  targetGap: number;
  startIconWidth: number;
  targetIconWidth: number;
};

type LoaderVisualProps = {
  phase: LoaderPhase;
  reduceMotion: boolean;
};

const refreshEase = [0.76, 0, 0.24, 1] as const;
const entranceEase = [0.16, 1, 0.3, 1] as const;
const loaderExitEase = [0.7, 0, 0.84, 0] as const;
const HOME_ANIMATION_SEEN_KEY = "bidsite-home-animation-seen";

const defaultMarkMetrics: MarkMetrics = {
  startCollapsedX: 0,
  startX: 0,
  startY: 0,
  targetX: 0,
  targetY: 0,
  startCollapsedWidth: 0,
  startWidth: 0,
  targetWidth: 0,
  startFontSize: 88,
  targetFontSize: 21,
  startLineHeight: 82,
  targetLineHeight: 20,
  startLetterSpacing: -5.2,
  targetLetterSpacing: -1.2,
  startGap: 33,
  targetGap: 8.8,
  startIconWidth: 70,
  targetIconWidth: 16.32,
};

const particleConfigs = [
  { left: "22%", top: "40%", size: 3.5, delay: 0.2 },
  { left: "72%", top: "30%", size: 3, delay: 0.26 },
  { left: "44%", top: "72%", size: 2.5, delay: 0.3 },
  { left: "82%", top: "52%", size: 3, delay: 0.24 },
  { left: "12%", top: "58%", size: 2, delay: 0.32 },
  { left: "56%", top: "62%", size: 2, delay: 0.28 },
] as const;

const orbConfigs = [
  {
    style: {
      left: "30%",
      top: "25%",
      width: "min(26rem, 58vw)",
      height: "min(26rem, 58vw)",
      background:
        "radial-gradient(circle, rgba(59,130,246,0.22) 0%, transparent 70%)",
    },
    initialScale: 2.2,
    introOpacity: 0.85,
    introScale: 1.4,
    moveOpacity: 0.5,
    moveX: -90,
    moveY: -50,
    settledOpacity: 0.18,
  },
  {
    style: {
      left: "52%",
      top: "18%",
      width: "min(20rem, 44vw)",
      height: "min(20rem, 44vw)",
      background:
        "radial-gradient(circle, rgba(241,245,249,0.09) 0%, transparent 70%)",
    },
    initialScale: 1.8,
    introOpacity: 0.65,
    introScale: 1.2,
    moveOpacity: 0.35,
    moveX: 30,
    moveY: -40,
    settledOpacity: 0.08,
  },
  {
    style: {
      right: "8%",
      bottom: "12%",
      width: "min(22rem, 50vw)",
      height: "min(22rem, 50vw)",
      background:
        "radial-gradient(circle, rgba(30,58,138,0.38) 0%, transparent 70%)",
    },
    initialScale: 1.6,
    introOpacity: 0.7,
    introScale: 1.3,
    moveOpacity: 0.4,
    moveX: 50,
    moveY: 30,
    settledOpacity: 0.25,
  },
] as const;

function shouldSkipHomeAnimation() {
  if (consumeNextHomeNavigationWithoutAnimation()) {
    return true;
  }

  try {
    const navigation = window.performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigation?.type === "reload") {
      window.sessionStorage.setItem(HOME_ANIMATION_SEEN_KEY, "1");
      return false;
    }

    if (window.sessionStorage.getItem(HOME_ANIMATION_SEEN_KEY) === "1") {
      return true;
    }
    window.sessionStorage.setItem(HOME_ANIMATION_SEEN_KEY, "1");
  } catch {
    // Keep the first-load animation if browser storage is unavailable.
  }

  return false;
}

function bodyLoaderState({
  completed,
  metricsReady,
  phase,
  visible,
}: {
  completed: boolean;
  metricsReady: boolean;
  phase: LoaderPhase;
  visible: boolean;
}) {
  if (completed) return "done";
  if (!visible) return "settled";
  return metricsReady ? phase : "boot";
}

function measureBrandHandoff(reduceMotion: boolean): MarkMetrics | null {
  const anchor = document.querySelector<HTMLElement>("[data-brand-anchor='true']");
  if (!anchor) return null;

  const anchorIcon = anchor.querySelector<HTMLElement>(".brand-logo__mark");
  const anchorWord = anchor.querySelector<HTMLElement>(".brand-logo__wordmark");
  const anchorRect = anchor.getBoundingClientRect();
  const anchorStyle = window.getComputedStyle(anchor);
  const targetWidth = Math.max(anchorRect.width, anchor.scrollWidth) + 6;
  const targetFontSize = Number.parseFloat(anchorStyle.fontSize) || 21;
  const targetGapRaw = Number.parseFloat(anchorStyle.gap);
  const iconRect = anchorIcon?.getBoundingClientRect();
  const wordRect = anchorWord?.getBoundingClientRect();
  const measuredGap =
    iconRect && wordRect ? Math.max(0, wordRect.left - iconRect.right) : Number.NaN;
  const targetGap = Number.isFinite(measuredGap)
    ? measuredGap
    : Number.isFinite(targetGapRaw)
      ? targetGapRaw
      : 8.8;
  const targetLetterSpacing =
    Number.parseFloat(anchorStyle.letterSpacing) || targetFontSize * -0.06;
  const targetLineHeightRaw = Number.parseFloat(anchorStyle.lineHeight);
  const targetLineHeight = Number.isFinite(targetLineHeightRaw)
    ? targetLineHeightRaw
    : targetFontSize * 0.92;
  const targetIconWidth = anchorIcon?.getBoundingClientRect().width || 16.32;
  const startFontSize = reduceMotion
    ? targetFontSize
    : Math.max(targetFontSize * 3.8, Math.min(window.innerWidth * 0.108, 112));
  const scaleRatio = startFontSize / targetFontSize;
  const startLineHeight = targetLineHeight * scaleRatio;
  const startLetterSpacing = targetLetterSpacing * scaleRatio;
  const startGap = targetGap * scaleRatio;
  const startIconWidth = targetIconWidth * scaleRatio;
  const startWidth = targetWidth * scaleRatio;
  const startCollapsedWidth = Math.max(startFontSize * 0.84, 58);

  return {
    startCollapsedX: window.innerWidth / 2 - startCollapsedWidth / 2,
    startX: window.innerWidth / 2 - startWidth / 2,
    startY: window.innerHeight / 2 - startLineHeight / 2,
    targetX: anchorRect.left,
    targetY: anchorRect.top + (anchorRect.height - targetLineHeight) / 2,
    startCollapsedWidth,
    startWidth,
    targetWidth,
    startFontSize,
    targetFontSize,
    startLineHeight,
    targetLineHeight,
    startLetterSpacing,
    targetLetterSpacing,
    startGap,
    targetGap,
    startIconWidth,
    targetIconWidth,
  };
}

function sheetWashOpacity(phase: LoaderPhase) {
  if (phase === "intro") return 1;
  if (phase === "move") return 0.96;
  return 0.92;
}

function orbAnimation(
  phase: LoaderPhase,
  reduceMotion: boolean,
  config: (typeof orbConfigs)[number],
) {
  if (phase === "intro") {
    return {
      opacity: reduceMotion ? 0.3 : config.introOpacity,
      scale: reduceMotion ? 1 : config.introScale,
      transition: {
        duration: reduceMotion ? 0.2 : 0.9,
        delay: 0.08,
        ease: entranceEase,
      },
    };
  }

  if (phase === "move") {
    return {
      opacity: reduceMotion ? 0.15 : config.moveOpacity,
      scale: 1,
      x: reduceMotion ? 0 : config.moveX,
      y: reduceMotion ? 0 : config.moveY,
      transition: {
        duration: reduceMotion ? 0.14 : 0.85,
        ease: refreshEase,
      },
    };
  }

  return {
    opacity: reduceMotion ? 0.08 : config.settledOpacity,
    scale: 0.9,
    transition: {
      duration: reduceMotion ? 0.1 : 0.4,
    },
  };
}

function particleAnimation(phase: LoaderPhase, reduceMotion: boolean, delay: number) {
  if (phase === "intro") {
    return {
      opacity: reduceMotion ? 0.25 : 0.6,
      scale: 1,
      transition: {
        duration: reduceMotion ? 0.14 : 0.5,
        delay,
      },
    };
  }

  if (phase === "move") {
    return {
      opacity: reduceMotion ? 0.12 : 0.32,
      scale: 0.7,
      transition: {
        duration: reduceMotion ? 0.12 : 0.6,
        ease: refreshEase,
      },
    };
  }

  return {
    opacity: reduceMotion ? 0.05 : 0.12,
    scale: 0.5,
    transition: {
      duration: reduceMotion ? 0.08 : 0.3,
    },
  };
}

function edgeLineAnimation(phase: LoaderPhase, reduceMotion: boolean) {
  if (phase === "intro") {
    return {
      opacity: reduceMotion ? 0.35 : 0.75,
      scaleX: 1,
      transition: {
        duration: reduceMotion ? 0.18 : 0.82,
        delay: 0.12,
        ease: entranceEase,
      },
    };
  }

  if (phase === "move") {
    return {
      opacity: reduceMotion ? 0.2 : 0.45,
      scaleX: 0.5,
      transition: {
        duration: reduceMotion ? 0.14 : 0.65,
        ease: refreshEase,
      },
    };
  }

  return {
    opacity: reduceMotion ? 0.08 : 0.18,
    scaleX: 0.35,
    transition: {
      duration: reduceMotion ? 0.1 : 0.35,
    },
  };
}

function markContainerAnimation(
  phase: LoaderPhase,
  metrics: MarkMetrics,
  reduceMotion: boolean,
) {
  if (phase === "intro") {
    return {
      opacity: 1,
      left: metrics.startCollapsedX,
      top: metrics.startY,
      width: metrics.startCollapsedWidth,
      fontSize: `${metrics.startFontSize}px`,
      lineHeight: `${metrics.startLineHeight}px`,
      letterSpacing: `${metrics.startLetterSpacing}px`,
      filter: "blur(0px)",
      transition: {
        duration: reduceMotion ? 0.22 : 0.82,
        delay: 0.08,
        ease: entranceEase,
      },
    };
  }

  if (phase === "reveal") {
    return {
      opacity: 1,
      left: metrics.startX,
      top: metrics.startY,
      width: metrics.startWidth,
      fontSize: `${metrics.startFontSize}px`,
      lineHeight: `${metrics.startLineHeight}px`,
      letterSpacing: `${metrics.startLetterSpacing}px`,
      filter: "blur(0px)",
      transition: {
        duration: reduceMotion ? 0.18 : 0.56,
        ease: entranceEase,
      },
    };
  }

  const duration = phase === "move" ? (reduceMotion ? 0.2 : 0.9) : 0;
  return {
    opacity: 1,
    left: metrics.targetX,
    top: metrics.targetY,
    width: metrics.targetWidth,
    fontSize: `${metrics.targetFontSize}px`,
    lineHeight: `${metrics.targetLineHeight}px`,
    letterSpacing: `${metrics.targetLetterSpacing}px`,
    filter: "blur(0px)",
    transition: {
      duration,
      delay: phase === "move" ? (reduceMotion ? 0.02 : 0.08) : 0,
      ease: refreshEase,
    },
  };
}

function markIconAnimation(
  phase: LoaderPhase,
  metrics: MarkMetrics,
  reduceMotion: boolean,
) {
  if (phase === "intro" || phase === "reveal") {
    return {
      opacity: 1,
      scale: 1,
      rotate: 0,
      width: metrics.startIconWidth,
      transition: {
        duration: phase === "intro" ? (reduceMotion ? 0.18 : 0.52) : 0.32,
        delay: phase === "intro" && !reduceMotion ? 0.04 : 0,
        ease: entranceEase,
      },
    };
  }

  return {
    opacity: 1,
    scale: 1,
    rotate: 0,
    width: metrics.targetIconWidth,
    transition: {
      duration: phase === "move" ? (reduceMotion ? 0.2 : 0.9) : 0.24,
      delay: phase === "move" ? (reduceMotion ? 0.02 : 0.08) : 0,
      ease: refreshEase,
    },
  };
}

function wordRevealTransition(phase: LoaderPhase, reduceMotion: boolean) {
  if (phase === "move") {
    return {
      duration: reduceMotion ? 0.2 : 0.9,
      delay: reduceMotion ? 0.02 : 0.08,
      ease: refreshEase,
    };
  }

  return {
    duration: phase === "settled" ? (reduceMotion ? 0.12 : 0.2) : 0.56,
    ease: entranceEase,
  };
}

function wordmarkAnimation(phase: LoaderPhase, reduceMotion: boolean) {
  if (phase === "intro") {
    return {
      x: "-106%",
      opacity: 0,
      transition: { duration: 0.12 },
    };
  }

  if (phase === "reveal") {
    return {
      x: "0%",
      opacity: 1,
      transition: {
        duration: reduceMotion ? 0.2 : 0.62,
        delay: reduceMotion ? 0 : 0.04,
        ease: entranceEase,
      },
    };
  }

  return {
    x: "0%",
    opacity: 1,
    transition: {
      duration: reduceMotion ? 0.14 : 0.24,
      ease: refreshEase,
    },
  };
}

function introRuleAnimation(phase: LoaderPhase, reduceMotion: boolean) {
  if (phase === "intro") {
    return {
      opacity: 1,
      scaleX: 1,
      transition: {
        duration: reduceMotion ? 0.18 : 0.72,
        delay: reduceMotion ? 0.06 : 0.22,
        ease: entranceEase,
      },
    };
  }

  return {
    opacity: 0,
    scaleX: 0.4,
    transition: { duration: reduceMotion ? 0.08 : 0.24 },
  };
}

function LoaderSheets({ phase, reduceMotion }: LoaderVisualProps) {
  return (
    <>
      <motion.div
        className="bidsite-refresh-loader__halo"
        initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.82 }}
        animate={
          phase === "intro"
            ? {
                opacity: 1,
                scale: 1,
                transition: {
                  duration: reduceMotion ? 0.2 : 0.78,
                  ease: entranceEase,
                },
              }
            : {
                opacity: 0,
                scale: reduceMotion ? 1 : 1.18,
                transition: {
                  duration: reduceMotion ? 0.14 : 0.52,
                  ease: loaderExitEase,
                },
              }
        }
      />
      <motion.div
        className="bidsite-refresh-loader__sheet bidsite-refresh-loader__sheet--base"
        initial={{ scale: reduceMotion ? 1 : 1.06 }}
        animate={{
          scale: 1,
          transition: {
            duration: reduceMotion ? 0.18 : 0.86,
            ease: entranceEase,
          },
        }}
      />
      <motion.div
        className="bidsite-refresh-loader__sheet bidsite-refresh-loader__sheet--wash"
        initial={{ opacity: 0.88 }}
        animate={{
          opacity: sheetWashOpacity(phase),
          transition: {
            duration: reduceMotion ? 0.14 : 0.42,
            ease: entranceEase,
          },
        }}
      />
    </>
  );
}

function AmbientOrbs({ phase, reduceMotion }: LoaderVisualProps) {
  return (
    <>
      {orbConfigs.map((config, index) => (
        <motion.div
          key={index}
          className="bidsite-refresh-loader__orb"
          style={config.style}
          initial={{ opacity: 0, scale: reduceMotion ? 1 : config.initialScale }}
          animate={orbAnimation(phase, reduceMotion, config)}
        />
      ))}
    </>
  );
}

function DocumentStackSvg() {
  return (
    <svg width="110" height="120" viewBox="0 0 110 120" fill="none">
      <rect
        x="32"
        y="8"
        width="56"
        height="72"
        rx="4"
        fill="rgba(59,130,246,0.12)"
        stroke="rgba(147,197,253,0.45)"
        strokeWidth="1.2"
        transform="rotate(6 60 44)"
      />
      <rect
        x="18"
        y="16"
        width="56"
        height="72"
        rx="4"
        fill="rgba(59,130,246,0.22)"
        stroke="rgba(147,197,253,0.7)"
        strokeWidth="1.4"
      />
      <path
        d="M58 16v14a2 2 0 002 2h14"
        stroke="rgba(147,197,253,0.55)"
        strokeWidth="1.2"
      />
      <path d="M58 16l16 16" stroke="rgba(147,197,253,0.15)" strokeWidth="1" />
      {[44, 54, 64, 74].map((y, index) => (
        <line
          key={y}
          x1="28"
          y1={y}
          x2={[62, 56, 58, 44][index]}
          y2={y}
          stroke={`rgba(147,197,253,${[0.5, 0.4, 0.35, 0.25][index]})`}
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

function DataOrbitSvg() {
  return (
    <svg width="180" height="180" viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="42" stroke="rgba(147,197,253,0.4)" strokeWidth="1.2" />
      <circle
        cx="100"
        cy="100"
        r="70"
        stroke="rgba(147,197,253,0.3)"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <circle
        cx="100"
        cy="100"
        r="92"
        stroke="rgba(147,197,253,0.18)"
        strokeWidth="0.8"
        strokeDasharray="2 6"
      />
      <circle cx="142" cy="100" r="5" fill="rgba(96,165,250,0.55)" stroke="rgba(147,197,253,0.6)" strokeWidth="1" />
      <circle cx="100" cy="58" r="3.5" fill="rgba(96,165,250,0.45)" stroke="rgba(147,197,253,0.5)" strokeWidth="0.8" />
      <circle cx="38" cy="128" r="3" fill="rgba(96,165,250,0.35)" stroke="rgba(147,197,253,0.4)" strokeWidth="0.8" />
      <circle cx="100" cy="100" r="3" fill="rgba(147,197,253,0.5)" />
      <circle cx="172" cy="118" r="2.5" fill="rgba(96,165,250,0.3)" stroke="rgba(147,197,253,0.35)" strokeWidth="0.7" />
    </svg>
  );
}

function CloudUploadSvg() {
  return (
    <svg width="96" height="82" viewBox="0 0 96 82" fill="none">
      <path
        d="M24 58c-8.3 0-15-6.7-15-15 0-6.8 4.6-12.6 10.9-14.3C22 19.5 30.6 12 41 12c12.5 0 22.7 9.4 23.8 21.5h1.2C74.3 33.5 81 40.2 81 48.5S74.3 63.5 66 63.5H24z"
        fill="rgba(59,130,246,0.16)"
        stroke="rgba(147,197,253,0.65)"
        strokeWidth="1.4"
      />
      <path
        d="M48 36v18M40 44l8-8 8 8"
        stroke="rgba(191,219,254,0.8)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DecorativeVectors({ phase, reduceMotion }: LoaderVisualProps) {
  return (
    <>
      <MotionVector
        className="bidsite-refresh-loader__vector"
        style={{ right: "14%", top: "18%" }}
        initial={{ rotate: reduceMotion ? 0 : -12, scale: reduceMotion ? 1 : 0.6 }}
        intro={{ opacity: reduceMotion ? 0.3 : 0.72, rotate: -3, scale: 1 }}
        move={{ opacity: reduceMotion ? 0.18 : 0.4, rotate: -1, scale: 0.8, x: 25, y: -40 }}
        settled={{ opacity: reduceMotion ? 0.12 : 0.2, rotate: 0, scale: 0.78 }}
        phase={phase}
        reduceMotion={reduceMotion}
      >
        <DocumentStackSvg />
      </MotionVector>
      <MotionVector
        className="bidsite-refresh-loader__vector"
        style={{ left: "8%", bottom: "14%" }}
        initial={{ rotate: reduceMotion ? 0 : 15, scale: reduceMotion ? 1 : 0.5 }}
        intro={{ opacity: reduceMotion ? 0.2 : 0.55, rotate: 0, scale: 1 }}
        move={{ opacity: reduceMotion ? 0.12 : 0.3, scale: 0.85, x: -10, y: -30 }}
        settled={{ opacity: reduceMotion ? 0.08 : 0.18 }}
        phase={phase}
        reduceMotion={reduceMotion}
      >
        <DataOrbitSvg />
      </MotionVector>
      <MotionVector
        className="bidsite-refresh-loader__vector"
        style={{ right: "12%", bottom: "22%" }}
        initial={{ scale: reduceMotion ? 1 : 0.65, y: reduceMotion ? 0 : 24 }}
        intro={{ opacity: reduceMotion ? 0.2 : 0.55, scale: 1, y: 0 }}
        move={{ opacity: reduceMotion ? 0.1 : 0.3, scale: 0.88, x: 18, y: -25 }}
        settled={{ opacity: reduceMotion ? 0.06 : 0.15 }}
        phase={phase}
        reduceMotion={reduceMotion}
      >
        <CloudUploadSvg />
      </MotionVector>
    </>
  );
}

function MotionVector({
  children,
  className,
  initial,
  intro,
  move,
  phase,
  reduceMotion,
  settled,
  style,
}: LoaderVisualProps & {
  children: ReactNode;
  className: string;
  initial: Record<string, number>;
  intro: Record<string, number>;
  move: Record<string, number>;
  settled: Record<string, number>;
  style: Record<string, string>;
}) {
  const current = phase === "intro" ? intro : phase === "move" ? move : settled;
  const duration = phase === "intro" ? 0.95 : phase === "move" ? 0.85 : 0.4;

  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, ...initial }}
      animate={{
        ...current,
        x: reduceMotion ? 0 : current.x,
        y: reduceMotion ? 0 : current.y,
        transition: {
          duration: reduceMotion ? 0.14 : duration,
          delay: phase === "intro" ? 0.18 : 0,
          ease: phase === "move" ? refreshEase : [0.16, 1, 0.3, 1],
        },
      }}
    >
      {children}
    </motion.div>
  );
}

function FloatingParticles({ phase, reduceMotion }: LoaderVisualProps) {
  return (
    <>
      {particleConfigs.map((particle, index) => (
        <motion.div
          key={index}
          className="bidsite-refresh-loader__particle"
          style={{
            left: particle.left,
            top: particle.top,
            width: particle.size,
            height: particle.size,
          }}
          initial={{ opacity: 0, scale: 0 }}
          animate={particleAnimation(phase, reduceMotion, particle.delay)}
        />
      ))}
    </>
  );
}

function LoaderEdge({ phase, reduceMotion }: LoaderVisualProps) {
  return (
    <motion.div
      className="bidsite-refresh-loader__edge-line"
      initial={{ opacity: 0, scaleX: 0.2 }}
      animate={edgeLineAnimation(phase, reduceMotion)}
    />
  );
}

function LoaderBrandMark({
  metrics,
  phase,
  reduceMotion,
}: LoaderVisualProps & { metrics: MarkMetrics }) {
  return (
    <div className="bidsite-refresh-loader__center">
      <motion.div
        className="bidsite-refresh-loader__mark"
        initial={{
          opacity: 0,
          left: metrics.startCollapsedX,
          top: metrics.startY + (reduceMotion ? 0 : 26),
          width: metrics.startCollapsedWidth,
          fontSize: `${metrics.startFontSize}px`,
          lineHeight: `${metrics.startLineHeight}px`,
          letterSpacing: `${metrics.startLetterSpacing}px`,
          filter: reduceMotion ? "none" : "blur(12px)",
        }}
        animate={markContainerAnimation(phase, metrics, reduceMotion)}
        exit={{ opacity: 0, transition: { duration: 0 } }}
      >
        <motion.span className="bidsite-refresh-loader__mark-shell" initial={false}>
          <motion.img
            src="/bidsite-logo.png"
            alt=""
            aria-hidden="true"
            className="bidsite-refresh-loader__mark-icon"
            initial={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.74,
              rotate: reduceMotion ? 0 : -10,
            }}
            animate={markIconAnimation(phase, metrics, reduceMotion)}
          />
          <motion.span
            className="bidsite-refresh-loader__word-reveal"
            initial={false}
            animate={{
              marginLeft:
                phase === "intro" || phase === "reveal"
                  ? metrics.startGap
                  : metrics.targetGap,
            }}
            transition={wordRevealTransition(phase, reduceMotion)}
          >
            <motion.span
              className="bidsite-refresh-loader__wordmark"
              initial={{ x: "-106%", opacity: 0 }}
              animate={wordmarkAnimation(phase, reduceMotion)}
            >
              bidsite
            </motion.span>
          </motion.span>
        </motion.span>
      </motion.div>
      <motion.div
        className="bidsite-refresh-loader__rule"
        initial={{ opacity: 0, scaleX: 0.2 }}
        animate={introRuleAnimation(phase, reduceMotion)}
      />
    </div>
  );
}

function RefreshLoaderScene({
  metrics,
  phase,
  reduceMotion,
}: LoaderVisualProps & { metrics: MarkMetrics }) {
  return (
    <motion.div
      aria-hidden="true"
      className="bidsite-refresh-loader"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        transition: {
          delay: 0,
          duration: reduceMotion ? 0.1 : 0.16,
          ease: "easeOut",
        },
      }}
    >
      <LoaderSheets phase={phase} reduceMotion={reduceMotion} />
      <AmbientOrbs phase={phase} reduceMotion={reduceMotion} />
      <DecorativeVectors phase={phase} reduceMotion={reduceMotion} />
      <FloatingParticles phase={phase} reduceMotion={reduceMotion} />
      <LoaderEdge phase={phase} reduceMotion={reduceMotion} />
      <LoaderBrandMark
        metrics={metrics}
        phase={phase}
        reduceMotion={reduceMotion}
      />
    </motion.div>
  );
}

export function HomepageRefreshAnimation() {
  const reduceMotion = Boolean(useReducedMotion());
  const [skipAnimation, setSkipAnimation] = useState(false);
  const [visible, setVisible] = useState(true);
  const [completed, setCompleted] = useState(false);
  const [phase, setPhase] = useState<LoaderPhase>("intro");
  const [metricsReady, setMetricsReady] = useState(false);
  const [markMetrics, setMarkMetrics] = useState<MarkMetrics>(defaultMarkMetrics);

  useLayoutEffect(() => {
    if (!shouldSkipHomeAnimation()) return;
    setSkipAnimation(true);
    setVisible(false);
    setCompleted(true);
    setPhase("settled");
    setMetricsReady(true);
  }, []);

  useLayoutEffect(() => {
    document.body.dataset.homeLoader = skipAnimation
      ? "done"
      : bodyLoaderState({ completed, metricsReady, phase, visible });

    return () => {
      delete document.body.dataset.homeLoader;
    };
  }, [completed, metricsReady, phase, skipAnimation, visible]);

  useLayoutEffect(() => {
    if (skipAnimation || !visible) return;

    const updateHandoffTransform = () => {
      const nextMetrics = measureBrandHandoff(reduceMotion);
      if (!nextMetrics) return;
      setMarkMetrics(nextMetrics);
      setMetricsReady(true);
    };

    updateHandoffTransform();
    window.addEventListener("resize", updateHandoffTransform);

    return () => {
      window.removeEventListener("resize", updateHandoffTransform);
    };
  }, [reduceMotion, skipAnimation, visible]);

  useEffect(() => {
    if (skipAnimation || !visible) return;

    setCompleted(false);

    const revealTimeout = window.setTimeout(
      () => setPhase("reveal"),
      reduceMotion ? 120 : 620,
    );
    const moveTimeout = window.setTimeout(
      () => setPhase("move"),
      reduceMotion ? 240 : 1260,
    );
    const settledTimeout = window.setTimeout(
      () => setPhase("settled"),
      reduceMotion ? 500 : 2280,
    );
    const hideTimeout = window.setTimeout(
      () => setVisible(false),
      reduceMotion ? 620 : 2390,
    );

    return () => {
      window.clearTimeout(revealTimeout);
      window.clearTimeout(moveTimeout);
      window.clearTimeout(settledTimeout);
      window.clearTimeout(hideTimeout);
    };
  }, [reduceMotion, skipAnimation, visible]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <AnimatePresence onExitComplete={() => setCompleted(true)}>
      {visible && metricsReady ? (
        <RefreshLoaderScene
          metrics={markMetrics}
          phase={phase}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

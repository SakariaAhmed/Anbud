"use client";

import type { AnimationItem } from "lottie-web";
import { useEffect, useRef } from "react";

export const DECORATIVE_LOTTIES = {
  dataOrbit: "https://assets2.lottiefiles.com/packages/lf20_bh69rwvr.json",
  documentFlight: "https://assets2.lottiefiles.com/packages/lf20_x62chJ.json",
} as const;

export function DecorativeLottie({
  src,
  animationData,
  className,
  speed = 0.55,
}: {
  src?: string;
  animationData?: unknown;
  className: string;
  speed?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let animation: AnimationItem | null = null;
    let cancelled = false;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    void import("lottie-web").then(({ default: lottie }) => {
      if (cancelled) {
        return;
      }

      animation = lottie.loadAnimation({
        container,
        renderer: "svg",
        loop: !prefersReducedMotion,
        autoplay: !prefersReducedMotion,
        ...(src ? { path: src } : { animationData }),
        rendererSettings: {
          preserveAspectRatio: "xMidYMid meet",
        },
      });

      animation.setSpeed(speed);
      if (prefersReducedMotion) {
        animation.addEventListener("DOMLoaded", () => {
          animation?.goToAndStop(48, true);
        });
      }
    });

    return () => {
      cancelled = true;
      animation?.destroy();
    };
  }, [animationData, speed, src]);

  return <div ref={containerRef} aria-hidden="true" className={className} />;
}

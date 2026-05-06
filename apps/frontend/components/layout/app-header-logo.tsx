"use client";

import Image from "next/image";
import Link from "next/link";

const SKIP_HOME_ANIMATION_KEY = "bidsite-skip-home-animation";

export function markNextHomeNavigationWithoutAnimation() {
  try {
    window.sessionStorage.setItem(SKIP_HOME_ANIMATION_KEY, "1");
  } catch {
    // Ignore storage access issues; navigation should still work.
  }
}

export function consumeNextHomeNavigationWithoutAnimation() {
  try {
    const shouldSkip =
      window.sessionStorage.getItem(SKIP_HOME_ANIMATION_KEY) === "1";
    if (shouldSkip) {
      window.sessionStorage.removeItem(SKIP_HOME_ANIMATION_KEY);
    }
    return shouldSkip;
  } catch {
    return false;
  }
}

export function AppHeaderLogo() {
  return (
    <Link
      href="/"
      className="brand-logo text-white"
      data-brand-anchor="true"
      onClick={markNextHomeNavigationWithoutAnimation}
    >
      <Image
        src="/bidsite-logo.png"
        alt=""
        width={184}
        height={249}
        aria-hidden="true"
        className="brand-logo__mark"
        priority
      />
      <span className="brand-logo__wordmark">bidsite</span>
    </Link>
  );
}

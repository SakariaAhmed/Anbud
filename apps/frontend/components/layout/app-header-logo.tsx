"use client";

import Image from "next/image";
import Link from "next/link";

export function AppHeaderLogo() {
  return (
    <Link
      href="/"
      className="brand-logo text-white"
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

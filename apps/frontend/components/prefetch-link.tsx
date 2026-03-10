"use client";

import Link from "next/link";
import { ComponentProps, useEffect } from "react";
import { useRouter } from "next/navigation";

import { prefetchWorkspaceCache } from "@/lib/client/workspace-cache";

type PrefetchLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
  eager?: boolean;
  workspaceBidId?: string;
};

export function PrefetchLink({ href, eager = false, onMouseEnter, onFocus, workspaceBidId, ...props }: PrefetchLinkProps) {
  const router = useRouter();
  const hrefText = href;

  function prefetchAll() {
    router.prefetch(hrefText as never);
    if (workspaceBidId) {
      void prefetchWorkspaceCache(workspaceBidId);
    }
  }

  useEffect(() => {
    if (!eager) {
      return;
    }
    prefetchAll();
  }, [eager, hrefText, router, workspaceBidId]);

  return (
    <Link
      href={href as never}
      onFocus={(event) => {
        prefetchAll();
        onFocus?.(event);
      }}
      onMouseEnter={(event) => {
        prefetchAll();
        onMouseEnter?.(event);
      }}
      prefetch
      {...props}
    />
  );
}

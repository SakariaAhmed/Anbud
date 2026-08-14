"use client";

import { SecureErrorScreen } from "@/components/errors/secure-error-screen";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <SecureErrorScreen code="500" onRetry={reset} />;
}

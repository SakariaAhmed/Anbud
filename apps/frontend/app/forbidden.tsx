import type { Metadata } from "next";

import { SecureErrorScreen } from "@/components/errors/secure-error-screen";

export const metadata: Metadata = {
  title: "Ingen tilgang · bidsite",
  robots: { index: false, follow: false },
};

export default function Forbidden() {
  return <SecureErrorScreen code="403" />;
}

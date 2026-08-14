import type { Metadata } from "next";

import { SecureErrorScreen } from "@/components/errors/secure-error-screen";

export const metadata: Metadata = {
  title: "Siden finnes ikke · bidsite",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <SecureErrorScreen code="404" />;
}

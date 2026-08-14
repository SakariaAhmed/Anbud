import type { Metadata } from "next";

import { SecureErrorScreen } from "@/components/errors/secure-error-screen";

export const metadata: Metadata = {
  title: "Innlogging kreves · bidsite",
  robots: { index: false, follow: false },
};

export default function Unauthorized() {
  return <SecureErrorScreen code="401" />;
}

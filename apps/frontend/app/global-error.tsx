"use client";

import { SecureErrorScreen } from "@/components/errors/secure-error-screen";

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="no">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "rgb(2 6 23)",
          color: "rgb(226 232 240)",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <SecureErrorScreen code="500" onRetry={reset} />
      </body>
    </html>
  );
}

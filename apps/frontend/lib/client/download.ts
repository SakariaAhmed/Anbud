"use client";

export function sanitizeDownloadFileBase(value: string, fallback: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

export function downloadBrowserBlob(
  fileName: string,
  blob: Blob,
  options: { revokeDelayMs?: number } = {},
) {
  const revokeDelayMs = options.revokeDelayMs ?? 1000;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  const revoke = () => URL.revokeObjectURL(url);
  if (revokeDelayMs > 0) {
    window.setTimeout(revoke, revokeDelayMs);
  } else {
    revoke();
  }
}

export function downloadTextFile(fileName: string, type: string, content: string) {
  downloadBrowserBlob(fileName, new Blob([content], { type }));
}

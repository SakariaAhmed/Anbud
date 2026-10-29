// Job progress is persisted inside the job message as a leading "[NN%]"
// marker. This module is the only writer and reader of that format.
const PROGRESS_MARKER = /^\[(\d{1,3})%\]\s*/;

export function formatJobProgress(percent: number, label: string) {
  const bounded = Math.min(100, Math.max(0, Math.round(percent)));
  return `[${bounded}%] ${label}`;
}

export function parseJobProgress(message: string): {
  percent: number | null;
  label: string;
} {
  const marker = message.match(PROGRESS_MARKER);
  return marker
    ? { percent: Number(marker[1]), label: message.slice(marker[0].length) }
    : { percent: null, label: message };
}

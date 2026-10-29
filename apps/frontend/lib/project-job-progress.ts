// Job progress is persisted inside the job message as a leading "[NN%]"
// marker, or "[NN-MM%]" when a long step may advance towards MM% while it
// runs. This module is the only writer and reader of that format.
const PROGRESS_MARKER = /^\[(\d{1,3})(?:-(\d{1,3}))?%\]\s*/;

const boundedPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

export function formatJobProgress(percent: number, label: string, ceiling?: number) {
  const start = boundedPercent(percent);
  const range = ceiling === undefined ? `${start}` : `${start}-${Math.max(start, boundedPercent(ceiling))}`;
  return `[${range}%] ${label}`;
}

export function parseJobProgress(message: string): {
  percent: number | null;
  ceiling: number | null;
  label: string;
} {
  const marker = message.match(PROGRESS_MARKER);
  return marker
    ? {
        percent: Number(marker[1]),
        ceiling: marker[2] === undefined ? null : Number(marker[2]),
        label: message.slice(marker[0].length),
      }
    : { percent: null, ceiling: null, label: message };
}

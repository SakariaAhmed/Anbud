import { Phase } from "@/lib/types";

const phaseClassMap: Record<string, string> = {
  Negotiation: "badge badge-negotiation",
  Awarded: "badge badge-awarded",
  Lost: "badge badge-lost"
};

export function PhaseBadge({ phase }: { phase: Phase | null }) {
  if (!phase) {
    return <span className="badge">Unknown</span>;
  }
  return <span className={phaseClassMap[phase] ?? "badge"}>{phase}</span>;
}

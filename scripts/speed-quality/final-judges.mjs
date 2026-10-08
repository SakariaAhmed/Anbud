import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
// A final bounded, explicitly separate Mini-judge protocol. Runs sequentially
// through the same aggregate budget proxy; never overlaps paid generations.
const groups = [
  ["quality-final-corrections-v1", "baseline", "high_level_design,chat,forbedret_kravsvar,losningsutkast,gjennomforing_og_risiko"],
  ["quality-final-corrections-v1", "baseline-sections", "section_strategy"],
  ["quality-expanded-v1", "baseline-function", "customer_analysis"],
  ["quality-expanded-v1", "baseline", "customer_analysis_v3,section_summary,executive_summary,bilag1_rekonstruksjon,tilbudsstrategi,verdiargumentasjon,anbefalt_arkitektur"],
  ["quality-expanded-v1", "baseline16k", "solution_evaluation"],
  ["quality-expanded-v1", "baseline-sections", "section_clarifications,section_design,section_risks,section_needs,section_keywords,section_services,section_value"],
];
const sourceCorrectionGroups = [
  ["quality-expanded-v1", "baseline", "executive_summary,customer_analysis_v3,section_summary"],
  ["quality-expanded-v1", "baseline-function", "customer_analysis"],
  ["quality-final-corrections-v1", "baseline", "high_level_design"],
  ["quality-final-corrections-v1", "baseline-sections", "section_strategy"],
  ["quality-expanded-v1", "baseline-sections", "section_clarifications,section_design,section_risks,section_needs,section_keywords,section_services,section_value"],
];
for (const [candidate, baseline, kinds] of process.argv.includes("--source-correction-only") ? sourceCorrectionGroups : groups) {
  const child = spawnSync(process.execPath, ["scripts/speed-quality/judge-pairs.mjs", `--candidate=${candidate}`, `--baseline=${baseline}`, `--kinds=${kinds}`, "--mode=quality", "--judge-model=gpt-5.4-mini", "--split=all"], { cwd: root, stdio: "inherit" });
  if (child.error || child.status !== 0) process.exit(child.status || 1);
}

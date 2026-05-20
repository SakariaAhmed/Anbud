const MAX_TECH_SIGNAL_WORDS = 8;

const BLOCKED_EXACT_SIGNAL_WORDS = new Set([
  "azure",
  "microsoft azure",
  "microsoft 365",
  "m365",
  "office 365",
  "sky",
  "cloud",
  "hybrid cloud",
  "private cloud",
  "public cloud",
  "it drift",
  "drift",
  "sikkerhet",
  "compliance",
  "etterlevelse",
  "governance",
  "nettverk",
  "backup",
  "modernisering",
  "digitalisering",
  "automatisering",
  "ssa-d",
  "gdpr",
  "wcag",
]);

const BLOCKED_SIGNAL_PATTERNS = [
  /\bannex\b/i,
  /\bappendix\b/i,
  /\bbilag\b/i,
  /\bvedlegg\b/i,
  /\bssa[-\s]?[a-z0-9]*\b/i,
  /\bavtale\b/i,
  /\bkontrakt\b/i,
  /\bkrav\b/i,
  /\bkapittel\b/i,
  /\btabell\b/i,
  /\bdokument\b/i,
  /^\d+(\.\d+)*\s*[-–]\s*/i,
  /^[A-Z]{0,3}\d+[A-Z]?\s*[-–]\s*\d+[A-Z]?$/i,
];

const CONCRETE_TECH_PATTERNS = [
  /\bazure\s+(arc|backup|monitor|policy|firewall|sentinel|lighthouse|landing zone|key vault|virtual desktop|expressroute|vpn gateway|site recovery|log analytics|automation|devops|sql|files|app service|functions|container apps|kubernetes service|aks)\b/i,
  /\bmicrosoft\s+defender\s+for\s+(endpoint|office 365|cloud|identity|cloud apps)\b/i,
  /\bdefender\s+for\s+(endpoint|office 365|cloud|identity|cloud apps)\b/i,
  /\bmicrosoft\s+entra\s+(id|conditional access|privileged identity management|pim|id governance)\b/i,
  /\bentra\s+(id|conditional access|privileged identity management|pim|id governance)\b/i,
  /\bconditional access\b/i,
  /\bprivileged identity management\b/i,
  /\bintune\b|\bmicrosoft intune\b/i,
  /\bautopilot\b|\bwindows autopilot\b/i,
  /\bsharepoint online\b/i,
  /\bexchange online\b/i,
  /\bteams phone\b|\bmicrosoft teams phone\b/i,
  /\bpower bi\b|\bfabric\b|\bmicrosoft fabric\b/i,
  /\bservice now\b|\bservicenow\b/i,
  /\bterraform\b/i,
  /\bkubernetes\b|\baks\b/i,
  /\bdocker\b|\bcontainer apps\b/i,
  /\bci\/?cd\b|\bazure devops\b|\bgithub actions\b/i,
  /\bopenapi\b|\brest api\b|\bgraphql\b|\bapi gateway\b|\bwebhook\b/i,
  /\boauth\s*2(\.0)?\b|\bopenid connect\b|\bsaml\s*2(\.0)?\b/i,
  /\bscim\b|\bldap\b/i,
  /\bsiem\b|\bsoc\b|\bedr\b|\bxdr\b/i,
  /\bveeam\b|\bcommvault\b|\brubrik\b/i,
  /\bpalo alto\b|\bfortinet\b|\bcisco meraki\b/i,
  /\bpostgresql\b|\bsql server\b|\boracle database\b/i,
  /\bnoark\b/i,
];

function normalizeComparableSignalWord(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function isProfessionalTechnologySignalWord(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return false;
  }

  const normalized = normalizeComparableSignalWord(trimmed);
  if (!normalized || BLOCKED_EXACT_SIGNAL_WORDS.has(normalized)) {
    return false;
  }

  if (BLOCKED_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return false;
  }

  return CONCRETE_TECH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function normalizeTechnologySignalWords(
  items: string[],
  options?: { max?: number },
) {
  const max = options?.max ?? MAX_TECH_SIGNAL_WORDS;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const trimmed = item.replace(/\s+/g, " ").trim();
    const key = normalizeComparableSignalWord(trimmed);
    if (!key || seen.has(key) || !isProfessionalTechnologySignalWord(trimmed)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);

    if (result.length >= max) {
      break;
    }
  }

  return result;
}

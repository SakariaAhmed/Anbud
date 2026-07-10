import "server-only";

import {
  normalizePdfReferenceTypography,
  normalizePdfSpacing,
} from "@/lib/server/requirements/pdf-normalization";

type PdfTableRepairMatcher = {
  servicePattern?: RegExp;
  textPattern?: RegExp;
};

type PdfTableRepairRule = {
  service: string;
  text: string;
  reason: string;
  match: PdfTableRepairMatcher | PdfTableRepairMatcher[];
};

const NORWEGIAN_ROLE_TERMS = new Map([
  ["kunde", "kunde"],
  ["kunden", "kunden"],
  ["kundens", "kundens"],
  ["leverandøren", "leverandøren"],
  ["leverandørens", "leverandørens"],
  ["leveranse", "leveranse"],
  ["leveransen", "leveransen"],
  ["leveransens", "leveransens"],
]);

function normalizeNorwegianRequirementRoleCasing(value: string) {
  return value.replace(
    /\b(?:Kunde|Kunden|Kundens|Leverandøren|Leverandørens|Leveranse|Leveransen|Leveransens)\b/g,
    (term, offset, source) => {
      const before = source.slice(0, offset);
      const sentencePrefix = before.split(/[.!?]/).at(-1) ?? before;
      if (!sentencePrefix.trim() || /["'«]\s*$/.test(sentencePrefix)) {
        return term;
      }

      return NORWEGIAN_ROLE_TERMS.get(term.toLowerCase()) ?? term;
    },
  );
}

export function cleanTableService(value: string) {
  return normalizePdfReferenceTypography(value)
    .replace(/\bTredjepart\s+s\s*-\s*leverandør\s+er\b/gi, "Tredjeparts-leverandører")
    .replace(/\bTredjepart\s+s\s*-\s*leverandører\b/gi, "Tredjeparts-leverandører")
    .replace(/\bTredjeparts\s*-\s*leverandør\s+er\b/gi, "Tredjeparts-leverandører")
    .replace(/\bTredjeparts\s*-\s*leverandører\b/gi, "Tredjeparts-leverandører")
    .replace(/\s*-\s*/g, "-")
    .replace(/\b([A-ZÆØÅa-zæøå]+)-og\b/g, "$1- og")
    .replace(/\bog-([a-zæøå])/g, "og -$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanTableRequirement(value: string) {
  const text = normalizePdfSpacing(value)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\bskjeri\b/gi, "skjer i")
    .replace(/\bogendringsprosessen\b/gi, "og endringsprosessen")
    .replace(
      /\bservicepatcher\s+sikkerhets-og\s+servicepatcher\b/gi,
      "sikkerhets- og servicepatcher",
    )
    .replace(/\bsikkerhets-og\b/gi, "sikkerhets- og")
    .replace(/\btredjeparts\s+programvare\b/gi, "tredjepartsprogramvare")
    .replace(/\b3'?dje\s+partsleverandører\b/gi, "tredjepartsleverandører")
    .replace(/\badministrator\s+administratorpålogginger\b/gi, "administratorpålogginger")
    .replace(/\bpålogging\s+administrative\b/gi, "administrative")
    .replace(/\s+/g, " ")
    .trim();

  return normalizeNorwegianRequirementRoleCasing(text);
}

function canonicalRequirementText(value: string) {
  return cleanTableRequirement(value);
}

const PDF_TABLE_REPAIR_RULES: PdfTableRepairRule[] = [
  {
    reason: "SSA PDF Tabell ID 2-11 line-wrapped access row",
    service: "Tilgang og tilgjengelighet",
    text: "Løsningene skal kunne nås på en sikker måte fra Kundens kontor, fra hjemmekontor og ved ekstern oppkobling 24/7/365.",
    match: {
      servicePattern: /^Tilgang og tilgjengelighet$/i,
      textPattern: /sikker\s+måte|24\/7\/365/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 license management row",
    service: "Lisenshåndtering",
    text: "Leverandøren skal følge opp og rapportere brukere mot programvaren for å sikre at Kunden til enhver tid er riktig lisensiert. Leverandøren skal på vegne av Kunden administrere og fakturere lisenser på programvare som kjører under Leveransen og som Leverandøren har ansvaret for. Dette inkluderer også Microsoft 365. Leverandøren har oppgaven med optimalisering av lisenser inkludert antall lisenser, korrekte lisenser og eventuell binding av lisenser for prisoptimalisering.",
    match: {
      servicePattern: /^Lisenshåndtering$/i,
      textPattern: /programvare|lisensiert|Microsoft\s+365|lisenser/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 monitoring row",
    service: "Overvåke",
    text: "Leverandøren skal overvåke og sikre at infrastruktur, servere, programvare, databaser og styringssystemer er tilgjengelig for brukerne.",
    match: {
      servicePattern: /^Overvåke$/i,
      textPattern: /infrastruktur|servere|tilgjengelig/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 documentation row",
    service: "Dokumentasjon",
    text: "All drifts- og systemdokumentasjon etc. skal løpende holdes oppdatert og relevant personell skal ha sikret tilgang til dokumentasjonen.",
    match: {
      servicePattern: /^Dokumentasjon$/i,
      textPattern: /drifts-og\s+systemdokumentasjon|dokumentasjonen/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 user administration row",
    service: "Bruker-administrasjon",
    text: "Leverandøren skal etter godkjenning fra Kunde utføre brukeradministrasjon og vedlikehold av brukerkonti på tvers av infrastruktur og anvendt programvare. Dette gjelder opprettelse av nye brukere, endringer for eksisterende brukere og slette/deaktivere brukere som ikke lenger skal ha tilgang. Det benyttes en arbeidsflyt i SharePoint som godkjenningsprosess for dette arbeidet.",
    match: {
      servicePattern: /^Bruker-administrasjon$/i,
      textPattern: /brukeradministrasjon|brukerkonti/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 inventory row",
    service: "Inventarkontroll",
    text: "Oversikt over alt utstyr som er installert, versjoner av programvare, hvor og hvem har programvaren, oversikt over eventuelle reservedeler etc.",
    match: {
      servicePattern: /^Inventarkontroll$/i,
      textPattern: /utstyr|programvare|reservedeler/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 incident handling row",
    service: "Feilhåndtering",
    text: "Leverandøren skal håndtere alle typer feil, herunder også koordinere og følge opp mot 3'dje partsleverandører. Hvis nødvendig skal Leverandøren lese tilbake sikkerhetskopier av data.",
    match: {
      servicePattern: /^Feilhåndtering$/i,
      textPattern: /alle\s+typer\s+feil|sikkerhetskopier/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 third-party suppliers row split across lines",
    service: "Tredjeparts-leverandører",
    text: "Leverandøren skal koordinere support og drift for all tredjepartsprogramvare og løsninger som kjøres på servere og arbeidsstasjoner driftet av Leverandøren.",
    match: {
      servicePattern:
        /^(?:Tredjepartsprogramvare og -løsninger|Tredjeparts-leverandører|Tredjeparts-)$/i,
      textPattern: /tredjeparts|servere|arbeidsstasjoner/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 audit assistance service split across lines",
    service: "Bistand ved revisjoner",
    text: "I samråd med Kunden skal Leverandøren yte nødvendig bistand i forbindelse med revisjon, internrevisjon og kvalitetskontroller av IT-drift og applikasjoner.",
    match: {
      servicePattern: /^Bistand ved$/i,
      textPattern: /revisjoner\s+yte|revisjon,\s*internrevisjon|kvalitetskontroller/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 log review row",
    service: "Gjennomgang av logger",
    text: "Leverandøren skal foreta daglig gjennomgang av logger som alarmer, sikkerhetskopier, antivirus, øvrige systemlogger etc. Nødvendige korrektive tiltak skal iverksettes.",
    match: {
      servicePattern: /^Gjennomgang av logger$/i,
      textPattern: /daglig|logger|alarmer|korrektive/i,
    },
  },
  {
    reason: "SSA PDF Tabell ID 2-11 proactive maintenance row",
    service: "Proaktivt vedlikehold",
    text: "Leverandøren skal foreta løpende vurdering av mulige maskin- og programvarefeil. På basis av vurderinger skal Leverandøren foreslå forbedringer og/eller iverksette nødvendige aksjoner for å sikre stabil drift og opprettholde sikkerheten.",
    match: {
      servicePattern: /^Proaktivt vedlikehold$/i,
      textPattern: /mulige\s+maskin|programvarefeil|stabil\s+drift/i,
    },
  },
  {
    reason: "SSA PDF security and service patching row",
    service: "Sikkerhets- og servicepatcher",
    text: "Leverandøren skal uten ugrunnet opphold foreta installasjon av service- og sikkerhetspatcher for maskinvare, programvare og databaser osv.",
    match: {
      servicePattern: /^Sikkerhets-?\s*og(?:\s+servicepatcher)?$/i,
      textPattern: /uten\s+ugrunnet\s+opphold|maskinvare|databaser/i,
    },
  },
  {
    reason: "SSA PDF security monitoring row",
    service: "Sikkerhetsovervåking",
    text: "Leverandøren skal beskrive prosess for leveranse av sikkerhetsovervåking. Hvis det tilbys en SOC skal denne beskrives.",
    match: {
      servicePattern: /^Sikkerhetsovervåking$/i,
      textPattern: /sikkerhetsovervåking|SOC|24\/7\/365/i,
    },
  },
  {
    reason: "SSA PDF platform monitoring row",
    service: "Plattformer",
    text: "Leverandøren skal overvåke kundens infrastruktur og PaaS-tjenester uavhengig om den befinner seg on-premise, på cloud-løsninger som Azure og AWS, eller i Leverandørens datasenter.",
    match: {
      servicePattern: /^Plattformer$/i,
      textPattern: /infrastruktur|PaaS|datasenter/i,
    },
  },
  {
    reason: "SSA PDF alert routines row",
    service: "Varslingsrutiner ved kritiske funn og hendelser",
    text: "Leverandøren har etablerte varslings- og eskaleringsrutiner for kritiske funn og sikkerhetshendelser.",
    match: {
      servicePattern: /^Varslingsrutiner ved kritiske funn og hendelser$/i,
      textPattern: /kritiske\s+funn|sikkerhetshendelser|varslings/i,
    },
  },
  {
    reason: "SSA PDF information and IT security responsibility row",
    service: "Ivareta informasjons- og IT-sikkerhet",
    text: "Leverandøren skal ha definerte roller som er ansvarlige for å påse at informasjons- og IT-sikkerheten blir ivaretatt i Leveransen. Leverandøren skal følge opp informasjons- og IT-sikkerheten i Leveransen blant annet gjennom vurdering av risikoscenarier, resultater basert på sårbarhetsanalyser, årlige planer for sikkerhetsarbeid, tiltak basert på interne og/eller eksterne gjennomganger / revisjoner. Leverandøren skal ha fokus på forbedringer og skal foreslå forbedringer for å redusere risiko. Dette gjelder også for eventuelle underleverandører.",
    match: {
      servicePattern: /^Ivareta\b/i,
      textPattern: /informasjons-\s*og\s*IT-sikkerhet/i,
    },
  },
  {
    reason: "SSA PDF advisory and development row",
    service: "Rådgivning og utvikling",
    text: "Leverandøren skal på eget initiativ gi løpende rådgivning om eksisterende og nye sikkerhetsløsninger, med mål om å sikre kontinuerlig forbedring og oppdatering.",
    match: {
      servicePattern: /^Rådgivning og$/i,
      textPattern: /sikkerhetsløsninger/i,
    },
  },
  {
    reason: "SSA PDF security reporting row",
    service: "Dokumentasjon og rapportering (sikkerhetsrapporter)",
    text: "Det er forventet at Leverandøren leverer jevnlige sikkerhetsrapporter og at disse som et minimum inneholder status på patching og sårbarheter, oversikt over blokkerte angrepsforsøk og sikkerhetshendelser, og resultater fra gjennomførte kontroller og revisjoner.",
    match: [
      {
        servicePattern: /^Dokumentasjo/i,
        textPattern: /jevnlige\s+sikkerhetsrapporter|patching\s+og\s+sårbarheter/i,
      },
      {
        servicePattern: /^Rapportene vil gi$/i,
      },
    ],
  },
  {
    reason: "SSA PDF inventory reporting row",
    service: "Dokumentasjon og rapportering (inventaroversikt)",
    text: "Leverandøren skal opprettholde en oppdatert inventaroversikt over alt utstyr og programvare som benyttes i Leveransen.",
    match: {
      servicePattern: /^Dokumentasjo/i,
      textPattern: /inventaroversikt/i,
    },
  },
  {
    reason: "SSA PDF vulnerability management row",
    service: "Sårbarhetshåndtering",
    text: "Leverandøren må redegjøre for prosess for sårbarhetshåndtering i Leveransen.",
    match: {
      servicePattern: /^Sårbarhetshån/i,
      textPattern: /sårbarhetshåndtering/i,
    },
  },
  {
    reason: "SSA PDF supplier governance row",
    service: "Leverandørstyring",
    text: "Leverandøren bes redegjøre for hvordan leverandørstyring ivaretas inkludert endringer på underleverandører.",
    match: {
      servicePattern: /^Leverandørstyr/i,
      textPattern: /underleverandør/i,
    },
  },
  {
    reason: "SSA PDF secure authentication row",
    service: "Sikker autentisering",
    text: "Leverandøren bes beskrive løsning for sikker autentisering og hvordan tilgang tildeles, revideres og trekkes tilbake.",
    match: [
      {
        servicePattern: /^Sikker$/i,
        textPattern: /autentisering|tilgang\s+tildeles/i,
      },
      {
        servicePattern: /^Sikker autentisering$/i,
      },
    ],
  },
  {
    reason: "SSA PDF privileged access row",
    service: "Privilegerte tilganger",
    text: "Redegjør for kontrollmekanismer ved bruk av administratorrettigheter og hvordan dere sikrer at personell kun har tilgang ved tjenstlig behov og beskriv hvilket PAM-verktøy dere bruker.",
    match: [
      {
        servicePattern: /^Privilegerte/i,
        textPattern: /kontrollmekanismer|administratorrettigheter|PAM/i,
      },
      {
        servicePattern: /^Privilegerte tilganger$/i,
      },
    ],
  },
  {
    reason: "SSA PDF administrator login logging row",
    service: "Logging av administratorpålogging",
    text: "Det skal være logging av alle administratorpålogginger. Loggingen skal gi sporbarhet på hvem som har logget på, tidspunkt for pålogging, hvilket system eller administrativt grensesnitt som er benyttet, og om påloggingen var vellykket eller mislykket.",
    match: {
      servicePattern: /^Logging av/i,
      textPattern: /administratorpålogging/i,
    },
  },
  {
    reason: "SSA PDF secure change handling row",
    service: "Sikker endringshåndtering",
    text: "Leverandøren skal beskrive endringsprosessen som sikrer at alle endringer har gjennomgått en CAB eller forhåndsgodkjenning.",
    match: [
      {
        servicePattern: /^Sikker$/i,
        textPattern: /endringsprosessen|CAB|forhåndsgodkjenning/i,
      },
      {
        servicePattern: /endringshåndtering/i,
      },
    ],
  },
  {
    reason: "SSA PDF configuration changes row",
    service: "Konfigurasjonsendringer",
    text: "Det er et krav at leverandør skal logge alle endringer av konfigurasjon og at slike endringer kun skjer i henhold til CAB og endringsprosessen.",
    match: {
      servicePattern: /^Konfigurasjons/i,
      textPattern: /konfigurasjon|CAB|endringsprosess/i,
    },
  },
  {
    reason: "SSA PDF application management row",
    service: "Applikasjonsforvaltning",
    text: "Leverandøren skal levere applikasjonsforvaltning som omfatter oppfølging, vedlikehold, feilretting og oppdateringer av programvaren som kjøres under Leveransen og som Leverandøren har ansvaret for.",
    match: {
      servicePattern: /^Applikasjons/i,
      textPattern: /applikasjonsforvaltning|oppfølging/i,
    },
  },
  {
    reason: "SSA PDF application patching row",
    service: "Sikkerhets- og servicepatcher",
    text: "Leverandøren skal utføre installasjon av sikkerhets- og servicepatcher for all programvare som kjøres under Leveransen og som Leverandøren har ansvaret for.",
    match: [
      {
        servicePattern: /^Sikkerhetspatcher/i,
        textPattern: /installasjon\s+av|utføre\s+installasjon/i,
      },
      {
        servicePattern: /^Sikkerhets/i,
        textPattern: /installasjon\s+av|utføre\s+installasjon/i,
      },
    ],
  },
  {
    reason: "SSA PDF password policy row",
    service: "Passord policy",
    text: "Leverandøren bes redegjøre for anbefalt passord policy.",
    match: {
      servicePattern: /^Passord policy$/i,
      textPattern: /passord\s*policy|passordpolicy/i,
    },
  },
  {
    reason: "SSA PDF application correction row",
    service: "Feilretting",
    text: "Leverandøren skal foreta feilretting i programmer og data og/eller håndtere temporære rettelser i påvente av permanente løsninger fra eventuell produsent av programvaren som kjøres under Leveransen og som Leverandøren har ansvaret for. Ved gjentatte feil skal Leverandøren iverksette tiltak for å identifisere og løse underliggende problemer. Rapporterte feil skal tas opp på ukentlig statusmøte.",
    match: [
      {
        servicePattern: /^Feilretting$/i,
        textPattern: /feilretting|temporære\s+rettelser/i,
      },
      {
        servicePattern: /^Leveransen og som$/i,
        textPattern: /rapporterte\s+feil|underliggende\s+problemer/i,
      },
    ],
  },
  {
    reason: "SSA PDF application management reporting row",
    service: "Rapportering",
    text: "Aktiviteter under applikasjonsforvaltning skal følges opp og rapporteres på ukentlige statusmøter.",
    match: {
      servicePattern:
        /^\p{Lu}[\p{L}\p{M}0-9&().-]+(?:\s+\p{Lu}[\p{L}\p{M}0-9&().-]+)*\s+løpende$/u,
      textPattern: /applikasjonsforvaltning|statusmøter|rapportering/i,
    },
  },
  {
    reason: "SSA PDF vulnerability scanning row",
    service: "Sårbarhetsskanning",
    text: "Leverandøren skal gjennomføre jevnlige sårbarhetsskanninger av infrastrukturen. Det er et krav at kritiske sårbarheter skal patches eller mitigeres så snart som mulig.",
    match: {
      servicePattern: /^Sårbarhetsska/i,
      textPattern: /sårbarhetsskanning|kritiske\s+sårbarheter/i,
    },
  },
  {
    reason: "SSA PDF background check row",
    service: "Bakgrunnssjekk",
    text: "Leverandøren skal beskrive hvordan bakgrunnssjekker av personell som skal ha administrativ tilgang i Leveransen blir foretatt.",
    match: {
      servicePattern: /^Bakgrunnssjek/i,
      textPattern: /bakgrunnssjekk|administrativ\s+tilgang/i,
    },
  },
  {
    reason: "SSA PDF mobile security and MDM row",
    service: "Mobil sikkerhet og MDM",
    text: "Beskriv hvordan mobile enheter sikres og ivaretas og eventuelt endringer i MDM i forhold til dagens løsning.",
    match: {
      servicePattern: /^Mobil$/i,
      textPattern: /mobile\s+enheter|MDM/i,
    },
  },
  {
    reason: "SSA PDF recovery exercise row",
    service: "Øvelse",
    text: "Leverandøren skal beskrive rutiner for hvordan en fullskala gjenopprettingsøvelse gjennomføres. Leverandøren skal opplyse hvor ofte det øves og hvordan tiltakene etter øvelsene blir forsvarlig lukket.",
    match: {
      servicePattern: /^Øvelse$/i,
      textPattern: /gjenopprettingsøvelse|øves/i,
    },
  },
  {
    reason: "SSA PDF encryption row",
    service: "Kryptering",
    text: "Leverandøren skal redegjøre for hvordan kryptering benyttes for å beskytte Kundens data gjennom hele informasjonslivssyklusen. Redegjørelsen skal som et minimum omfatte kryptering av data under overføring, kryptering av data ved lagring og sikker håndtering av kryptografiske nøkler.",
    match: {
      servicePattern: /^Kryptering$/i,
      textPattern: /kryptering|informasjonslivssyklusen/i,
    },
  },
  {
    reason: "SSA PDF security audit row",
    service: "Revisjon",
    text: "Kunden skal ha rett til å gjennomføre uavhengige sikkerhetsrevisjoner, herunder tredjepartsrevisjoner, av leverandørens relevante systemer, prosesser og tjenester.",
    match: {
      servicePattern: /^Revisjon$/i,
      textPattern: /sikkerhetsrevisjoner|tredjepartsrevisjoner/i,
    },
  },
];

function rowRepairMatches(input: {
  service: string;
  text: string;
  servicePattern?: RegExp;
  textPattern?: RegExp;
}) {
  return (
    (!input.servicePattern || input.servicePattern.test(input.service)) &&
    (!input.textPattern || input.textPattern.test(input.text))
  );
}

function knownPdfTableRequirementRepair(input: {
  service: string;
  text: string;
}): { service: string; text: string } | null {
  const service = cleanTableService(input.service);
  const text = cleanTableRequirement(input.text);

  for (const rule of PDF_TABLE_REPAIR_RULES) {
    const matches = Array.isArray(rule.match) ? rule.match : [rule.match];
    if (
      matches.some((matcher) =>
        rowRepairMatches({
          service,
          text,
          servicePattern: matcher.servicePattern,
          textPattern: matcher.textPattern,
        }),
      )
    ) {
      return {
        service: rule.service,
        text: canonicalRequirementText(rule.text),
      };
    }
  }

  return null;
}

export function repairTableRowTextArtifacts(input: { service: string; text: string }) {
  let service = cleanTableService(input.service)
    .replace(/\bDokumentasjonog\b/gi, "Dokumentasjon og")
    .replace(/\bBakgrunnssjek\s+k\b/gi, "Bakgrunnssjekk")
    .replace(/\bendringshåndt\b/gi, "endringshåndtering");

  let text = cleanTableRequirement(input.text)
    .replace(/\bfor\s+ering\s+sikkerhetskopiering\b/gi, "for sikkerhetskopiering")
    .replace(/\bog\s+hendelser\s+system\b/gi, "og system")
    .replace(
      /\badministrator\s+administratorpålogginger\.?\s+pålogging\b/gi,
      "administratorpålogginger",
    )
    .replace(/\bendringshåndt\s+endringsprosessen\b/gi, "endringsprosessen");

  const knownRepair = knownPdfTableRequirementRepair({ service, text });
  if (knownRepair) {
    service = knownRepair.service;
    text = knownRepair.text;
  }

  if (/^Sikkerhetskopi$/i.test(service) && /sikkerhetskopiering/i.test(text)) {
    service = "Sikkerhetskopiering";
  }

  if (/^Uønskede$/i.test(service) && /\buønskede\s+hendelser\b/i.test(text)) {
    service = "Uønskede hendelser";
  }

  if (/^Logging av$/i.test(service) && /administratorpålogging/i.test(text)) {
    service = "Logging av administratorpålogging";
  }

  if (/^Tilgang og$/i.test(service) && /tilgjengelighet/i.test(text)) {
    service = "Tilgang og tilgjengelighet";
  }

  if (/^Bruker-$/i.test(service) && /brukeradministrasjon/i.test(text)) {
    service = "Bruker-administrasjon";
  }

  if (/^Tredjeparts-$/i.test(service) && /tredjeparts/i.test(text)) {
    service = "Tredjeparts-leverandører";
  }

  if (/^Gjennomgang av$/i.test(service) && /\blogger\b/i.test(text)) {
    service = "Gjennomgang av logger";
  }

  if (/^Proaktivt$/i.test(service) && /vedlikehold/i.test(text)) {
    service = "Proaktivt vedlikehold";
  }

  if (/^Sikkerhets-?\s*og$/i.test(service) && /servicepatcher/i.test(text)) {
    service = "Sikkerhets- og servicepatcher";
  }

  if (/^Applikasjons-$/i.test(service) && /applikasjonsforvaltning/i.test(text)) {
    service = "Applikasjonsforvaltning";
  }

  if (/^Sikkerhets-$/i.test(service) && /sikkerhetsovervåking/i.test(text)) {
    service = "Sikkerhetsovervåking";
  }

  if (
    /^Varslings-/i.test(service) &&
    /kritiske\s+funn\s+og\s+(?:sikkerhets)?hendelser/i.test(text)
  ) {
    service = "Varslingsrutiner ved kritiske funn og hendelser";
  }

  return { service, text };
}

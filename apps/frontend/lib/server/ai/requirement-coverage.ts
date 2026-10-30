import "server-only";

// Requirement coverage evaluation: batch registries, evidence matching,
// retrieval context and deterministic control repairs for solution evaluation.
import { sortByRequirementOrder } from "@/lib/requirement-order";
import { compactText } from "@/lib/server/ai/context";
import { WorkflowIncompleteError } from "@/lib/server/workflow-errors";
import { retrieveDocumentSnippets } from "@/lib/server/document-chunks";
import {
  isNearDuplicate,
  normalizeComparableText,
  splitIntoSentences,
} from "@/lib/server/document-intelligence/text-normalization";
import { buildDelimitedContext } from "@/lib/server/prompts";
import {
  answerDefersRequirementConfirmation,
  answerExplicitlyDeclinesRequirement,
  answerHasSelfContainedCoverage,
  answerIsAttachmentBackedRequirementAnswer,
  answerIsVagueGenericRequirementAnswer,
  answerReferencesExternalAttachment,
  apiIntegrationTargets,
  canonicalNoManualSpreadsheetUserGroups,
  DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR,
  DETERMINISTIC_PRODUCTION_DIMENSIONING_TEMPLATE_REPAIR,
  deterministicControlSourceFields,
  deterministicControlSourceFlags,
  type DeterministicControlSourceFlags,
  type DeterministicSourceQualifier,
  dimensioningOperationProfile,
  dimensioningSourceQualifierDirective,
  documentedPerformanceTargets,
  EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT,
  EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
  EXACT_LOW_LATENCY_TENDER_REQUIREMENT,
  EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT,
  hasCompleteAcceptanceTestCoverage,
  hasCompleteAuditChangeLog,
  hasCompleteBackupRestoreVerification,
  hasCompleteHistoricalMigrationValidation,
  hasCompleteIdentityCrmApiContract,
  hasCompleteIdentityCrmLosslessContract,
  hasCompleteLifecycleStatusContract,
  hasCompleteLmsApiContract,
  hasCompleteLowLatencyTenderContract,
  hasCompleteLowLatencyTenderSourceBinding,
  hasCompleteOfflineTenderWorkflow,
  hasCompletePaymentApiContract,
  hasCompleteTimedReminderControl,
  isAcceptanceTestCoverageRequirement,
  isAuditChangeLogRequirement,
  isAutomaticNotificationAndAccessRequirement,
  isBackupRestoreVerificationRequirement,
  isCanonicalSinglePurposeProfiledDimensioningRequirement,
  isExactEmployeeMobileDimensioningRequirement,
  isExactIdentityCrmApiRequirement,
  isExactLmsApiRequirement,
  isExactPaymentApiRequirement,
  isHistoricalMigrationValidationRequirement,
  isLifecycleTraceabilityDimensioningRequirement,
  isLosslessQueueRetryRequirement,
  isMandatoryRequirementEntry,
  isNoManualSpreadsheetRequirement,
  isNoMaterialSlownessDimensioningRequirement,
  isResponseTimeAndAccessRequirement,
  isSeasonalScalabilityClarificationRequirement,
  isStructuredExportPortabilityRequirement,
  isTimedReminderControlRequirement,
  normalizeRequirementAnswerResult,
  realtimeCoordinationRequirementProfile,
  requirementAnswerQualityIssues,
  type RequirementAnswerResult,
  requirementExactlyMatches,
} from "@/lib/server/requirements/answer-quality";
import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import {
  dedupeRequirementLedger,
  hasRequirementSignal,
  hasStandaloneRequirementLanguage,
  isGeneratedRequirementId,
  isLikelyDetailOrAnswerBlock,
  isSyntheticRequirementId,
  normalizeCoverageEvidenceText,
  normalizeRequirementLedgerText,
  serviceFromTableRequirementId,
  stripAnswerTextFromRequirement,
} from "@/lib/server/requirements/pdf-layout-ledger";
import {
  normalizePageText,
  normalizePdfReferenceTypography,
  splitPdfPagesPreservingLines,
} from "@/lib/server/requirements/pdf-normalization";
import { cleanTableService } from "@/lib/server/requirements/pdf-table-repairs";
import {
  requirementDisplayRef,
  requirementDisplaySource,
  requirementFullReference,
  requirementGroupHeading,
  requirementHeadingPath,
  requirementLedgerSource,
  requirementPageRange,
  requirementSubtitle,
  sortRequirementLedgerInDocumentOrder,
} from "@/lib/server/requirements/presentation";
import { extractRequirementLedgerForDocumentCore, requirementSourceExcerptWithoutAnswer, substantiveRequirementAnswerExcerpt } from "@/lib/server/requirements/source-ledger";
import { canonicalizeRequirementSourceLedger } from "@/lib/server/requirements/source-readiness";
import { type RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { filterSyntheticRequirementFallbacks } from "@/lib/server/requirements/unstructured-ledger";
import { type ProjectDocumentDetail, type SolutionEvaluationResult } from "@/lib/types";
import {
  isRecord,
  type Untrusted,
  untrustedObject,
  untrustedRows,
} from "@/lib/unknown-values";
import { createHash } from "node:crypto";

export type DeterministicControlRepairStage = "pre_handoff" | "handoff";

export type RequirementLedgerConfidence = {
  level: "high" | "medium" | "low";
  score: number;
  requirement_count: number;
  source_locator_coverage: number;
  structured_entry_ratio: number;
  explicit_reference_ratio: number;
  generated_reference_count: number;
  extraction_methods: string[];
  reasons: string[];
};

export type RequirementCoverage = NonNullable<
  SolutionEvaluationResult["requirement_coverage"]
>;

export type RequirementCoverageItem = RequirementCoverage["items"][number];

export type RequirementCoverageBatchAnswer = {
  nr?: number;
  ref?: string;
  assessment?: string;
  vurdering?: string;
  rationale?: string;
  begrunnelse?: string;
  evidence?: string;
  bevis?: string;
  recommendation?: string;
  anbefaling?: string;
};

const REQUIREMENT_COVERAGE_EVALUATION_DETAIL_MAX_ROWS = parsePositiveIntegerEnv(
  "REQUIREMENT_COVERAGE_EVALUATION_DETAIL_MAX_ROWS",
  36,
);

const REQUIREMENT_COVERAGE_EVALUATION_DETAIL_CHAR_BUDGET =
  parsePositiveIntegerEnv(
    "REQUIREMENT_COVERAGE_EVALUATION_DETAIL_CHAR_BUDGET",
    48_000,
  );

const REQUIREMENT_COVERAGE_EVALUATION_REGISTRY_MAX_ROWS =
  parsePositiveIntegerEnv(
    "REQUIREMENT_COVERAGE_EVALUATION_REGISTRY_MAX_ROWS",
    500,
  );


export function parsePositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const STANDARD_SUPPLIER_PERFORMANCE_BASELINE =
  "p95 under 2 sekunder ved en antatt lastprofil på 200 samtidige brukere";

export function requiresExpandedRequirementAnswer(requirement: string) {
  const normalized = normalizeRequirementLedgerText(requirement);
  return (
    (/\bAPI\b/i.test(normalized) &&
      /\bautentisering\b/i.test(normalized) &&
      /\bdatamodell\b/i.test(normalized)) ||
    isBackupRestoreVerificationRequirement(normalized) ||
    requirementExactlyMatches(
      normalized,
      EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
    ) ||
    requirementExactlyMatches(normalized, EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT) ||
    requirementExactlyMatches(normalized, EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT) ||
    requirementExactlyMatches(normalized, EXACT_LOW_LATENCY_TENDER_REQUIREMENT)
  );
}

function mandatoryRequirementAnswerStructure(entry: RequirementLedgerEntry) {
  const requirement = normalizeRequirementLedgerText(entry.text);
  const checklist: string[] = [];

  if (
    /\bAPI\b/i.test(requirement) &&
    /\bautentisering\b/i.test(requirement) &&
    /\bdatamodell\b/i.test(requirement)
  ) {
    checklist.push(
      isExactIdentityCrmApiRequirement(requirement)
        ? "API for ID-porten og CRM: skill de to mekanismene. Beskriv ID-porten som føderert innlogging med OIDC Authorization Code og PKCE, tokenvalidering og konkrete identitetsclaims/felt; ikke modeller ID-porten som et generisk CRUD-register. Beskriv CRM separat med versjonert REST-API over HTTPS, OAuth 2.0-klientlegitimasjon, begrensede lese-/skrivescopes og navngitte operasjoner. Bind en foreslått datamodell til begge med objekter, nøkkelfelt, konkret feltmapping, autoritativt system/masterdataansvar, synkretning, validering og avvisning/feilkø; merk udokumenterte detaljer som foreslått integrasjonskontrakt, ikke kundefakta"
        : isExactPaymentApiRequirement(requirement)
          ? "betalings-API: beskriv en foreslått, versjonert REST-kontrakt med OAuth 2.0-klientlegitimasjon og begrensede lese-, opprettings- og callback-rettigheter. Datamodellen må binde betalingstransaksjon, kurspåmelding, deltakerkobling og oppgjør til transaksjons-ID, påmeldings-ID og deltaker-ID og konkret feltmapping av beløp, valuta, betalingsstatus, tidsstempel, feilkode og oppgjørsreferanse. Skill autoritativt ansvar mellom skyplattformens påmelding/deltakerkobling og betalingsløsningens transaksjon/status/oppgjør, angi foreslått synkretning, validering og feilkø uten å fremstille modellen som eksisterende kundefakta"
          : isExactLmsApiRequirement(requirement)
            ? "LMS-API: beskriv en foreslått, versjonert REST-kontrakt med OAuth 2.0-klientlegitimasjon og begrensede lese-/skrivescopes. Datamodellen må omfatte kurs, kursgjennomføring, deltaker, prøve, resultat og sertifikat med kurs-ID, gjennomførings-ID, deltaker-ID, prøve-ID og sertifikat-ID og konkret feltmapping av påmeldingsstatus, poengsum, beståttstatus og gyldighetsperiode. Skill autoritativt ansvar og synkretning for LMS-innhold/resultat og skyplattformens påmelding/sertifikat, og angi validering og feilkø uten å fremstille modellen som eksisterende kundefakta"
        : "API: angi et versjonert REST-API over HTTPS eller et like konkret produktnøytralt utvekslingsmønster og navngi operasjoner; autentisering og autorisasjon: angi OAuth 2.0/OIDC, klientlegitimasjon eller tjenesteidentitet med begrensede scopes/rettigheter; datamodell: navngi minst to kravrelevante objekter eller dataelementer, identifikator/nøkkelfelt og konkrete felt; angi feltmapping, masterdataansvar, synkretning og eksplisitt avvisning/avvikshåndtering for manglende, ugyldige eller konfliktende data for alle integrasjonsmål i kravet. Udokumenterte operasjoner, felt, dataeierskap og synkretning skal beskrives som en foreslått integrasjonskontrakt, ikke som eksisterende kundefakta",
    );
  }

  if (
    /\bsikker datadeling\b/i.test(requirement) &&
    /\bekstern(?:e)? aktør/i.test(requirement)
  ) {
    checklist.push(
      "sikker ekstern deling: angi konkret kanal som API, portal eller sikker filoverføring, autentisert rolle/tjenesteidentitet, minste privilegium, dataavgrensning og sporbar logging",
    );
  }

  if (/\bdatavalidering\b/i.test(requirement) && /\btilgang\b/i.test(requirement)) {
    checklist.push(
      "datavalidering og tilgang: angi obligatoriske felt, format-/regelkontroll og avvisning eller flagging av feil, samt rollebasert tilgang, minste privilegium, dataavgrensning og logging",
    );
  }

  if (/testmiljø/i.test(requirement)) {
    checklist.push(
      "testmiljø: bekreft tilgang før produksjonssetting og angi representative testdata, testscenarier, forventede resultater, dokumenterte avvik/tiltak og godkjenning eller go/no-go",
    );
  }

  if (
    /\b(?:overvåk|monitor)/i.test(requirement) &&
    /\b(?:varsl|alert|hendelse)/i.test(requirement)
  ) {
    checklist.push(
      "overvåking og varsling: angi målepunkter eller tilstander, ansvarlige mottakere og eskalering, hendelsesoppfølging og eventuell rapportfrekvens med konkret rapportinnhold",
    );
  }

  if (isNoManualSpreadsheetRequirement(requirement)) {
    const namedUsers = canonicalNoManualSpreadsheetUserGroups(entry) ?? [];
    checklist.push(
      `arbeid uten manuelle regneark: bekreft at ${namedUsers.length ? joinNorwegianList(namedUsers) : "brukerne"} utfører oppgaver, registrering og oppfølging direkte i løsningen; beskriv at oppgaver opprettes, oppdateres og deles i arbeidsflyten, at data registreres én gang i et felles datagrunnlag og gjenbrukes eller synkroniseres via integrasjoner, og at manuelle regneark ikke brukes`,
    );
  }

  if (isLosslessQueueRetryRequirement(requirement)) {
    checklist.push(
      requirementExactlyMatches(requirement, EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT)
        ? "tapsfri ID-porten/CRM-integrasjon: skill eksplisitt mellom ID-portens synkrone OIDC-innlogging, som ikke køes eller replayes og ikke lagrer domeneendringer ved autentiseringsfeil, og CRM-opprettelse/-oppdatering, som bruker varig outbox, idempotensnøkkel, kontrollert retry, dead-letter-kø og checkpoint. Bind korrelasjons-ID, sporbar hendelseslogg og avstemming til kurs, prøver, sertifikater og deltakerprofiler og verifiser én godkjent endring før køposten lukkes"
        : "tapsfri integrasjon: angi minst én duplikatsikker mekanisme som idempotens/idempotensnøkkel, deduplisering eller duplikatkontroll, og minst én recovery-/tapsmekanisme som varig kø, outbox/inbox, checkpoint, dead-letter/feilkø eller avstemming; beskriv også kø, kontrollert retry/nykjøring og sporbar logging",
    );
  }

  if (
    requirementExactlyMatches(
      requirement,
      EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
    )
  ) {
    checklist.push(
      "statusmodell som leverandøravklaring: foreslå konkrete standardstatuser og hovedoverganger separat for kurs, prøver, sertifikater og deltakerprofiler; bind hver overgang til ansvarlig rolle, tidsstempel og historikk; si tydelig hva som er standard i leveransen og at bare kundespesifikke overgangsregler er konfigurasjon, uten å utsette kjernefunksjonen til design",
    );
  }

  if (requirementExactlyMatches(requirement, EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT)) {
    checklist.push(
      "offline-støtte som leverandøravklaring: dekk uttrykkelig påmelding, eksamensbesvarelse/prøveresultat og sertifikatgrunnlag eller tidligere utstedt sertifikatbevis; angi eventuell sikker nettgrense for endelig utstedelse. Beskriv kryptert lokal kø, idempotensnøkkel, bruker-/enhetsidentitet, tidsstempel, ordnet synkronisering, konflikt uten overskriving, nykjøring og sporbar avvikslogg",
    );
  }

  if (requirementExactlyMatches(requirement, EXACT_LOW_LATENCY_TENDER_REQUIREMENT)) {
    const lowLatencyFlags = deterministicControlSourceFlags(entry);
    const sourceBinding = lowLatencyFlags.option
      ? "Bevar kildens opsjonsstatus uttrykkelig med formuleringen «separat priset opsjon»"
      : lowLatencyFlags.designPhase
        ? "Bevar designfasen, men avgrens den til validering av endelig lastprofil mot målet som forpliktes nå"
        : lowLatencyFlags.needsNote
          ? "Bevar at dette er kravraden fra behovsarbeidet"
          : "Ikke introduser opsjon, designfase eller andre kvalifikatorer som ikke finnes i kilderaden";
    checklist.push(
      `lav ventetid: bind påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat til leveransen. Bruk bare Ateas tilbudte leverandørbaseline ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}, uttrykkelig som leverandørforutsetning og ikke kundekrav; angi last-/ytelsestest, p95-måling per operasjon, varsling, avviksoppfølging, kapasitet og skalering. ${sourceBinding}${lowLatencyFlags.priority ? ` og oppgi prioritet «${lowLatencyFlags.priority}»` : ""}`,
    );
  }

  if (isResponseTimeAndAccessRequirement(requirement)) {
    checklist.push(
      "responstid og tilgang: angi konkrete målepunkter, percentiler eller navngitte brukertransaksjoner uten å dikte terskler, varsling og avviksoppfølging, samt rollemodell, minste privilegium og dataavgrensning per brukergruppe",
    );
  }

  if (isAutomaticNotificationAndAccessRequirement(requirement)) {
    checklist.push(
      "automatisk varsling og tilgang: navngi minst to konkrete hendelser eller triggere, leveringskanal som varsel i løsningen, e-post, SMS eller push, og hvem som mottar hva per rolle; angi samtidig rollebasert minste privilegium og konkret dataavgrensning per brukergruppe, oppgave eller objekt",
    );
  }

  if (isNoMaterialSlownessDimensioningRequirement(requirement)) {
    const lifecycleTraceability =
      isLifecycleTraceabilityDimensioningRequirement(requirement);
    const operationProfile = dimensioningOperationProfile(requirement);
    const operationDirective = operationProfile
      ? `bruk de tre eksakte, navngitte operasjonene ${operationProfile.operations.join(", ")}`
      : "navngi minst tre konkrete operasjoner fra kilderadens arbeidsflyt";
    const sourceTargets = documentedPerformanceTargets(entry);
    const qualifierDirective = dimensioningSourceQualifierDirective(entry);
    checklist.push(
      `dimensjonering uten treghet: ${
        lifecycleTraceability
          ? `bind ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og logging, til ytelsesmåling; ${operationDirective}`
          : `bind den konkrete dimensjoneringsgjenstanden og arbeidsflyten i kilderaden til ytelsesmåling; ${operationDirective}; ikke introduser innmelding-til-avslutning eller andre arbeidsflyter som ikke finnes i kilden`
      }; forplikt nå kapasitetsmodell eller baseline, last-/ytelsestest, enten dynamisk skalering eller eksplisitt dimensjonert/provisjonert kapasitet, alltid med reservekapasitet eller kapasitetsmargin; ikke avklar eller utsett disse kjerneelementene. ${
        sourceTargets.length
          ? "Gjenta og forplikt alle tallfestede ytelsesmål fra kilden som akseptansekriterier for de samme transaksjonene"
          : `Bruk nå den konfigurerte leverandørbaselinen eksakt: ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}; bind den til de samme transaksjonene i samme setning som Ateas tilbudte leverandørforslag og akseptansekriterium, og merk uttrykkelig at både responstidsmålet og lastprofilen er leverandørens tilbudte forutsetning, ikke et kundekrav fra kilden; ikke angi andre ytelsestall`
      }${qualifierDirective ? `; ${qualifierDirective}` : ""}`,
    );
    if (isExactEmployeeMobileDimensioningRequirement(requirement)) {
      checklist.push(
        "mobil/nettbrett-omfang: bekreft at dimensjonering og responstidsmålet gjelder alle ansattefunksjoner og arbeidsflater; merk de tre navngitte operasjonene som representative kritiske akseptansetransaksjoner, ikke som en avgrensning av leveranseomfanget. Mål faktiske arbeidsflyter og valider topprofil samt enhets-/nettlesermatrise sammen med kunden som en uttrykkelig avtalt akseptanse- og dimensjoneringsprofil; merk leverandørbaselinen som inkludert minste dimensjoneringsgrunnlag, ikke kundens volum, og dokumenter vesentlige avvik som kapasitet- og prisforutsetning for godkjenning før produksjonssetting uten å love ubegrenset kapasitet",
      );
    }
  }

  if (isSeasonalScalabilityClarificationRequirement(requirement)) {
    checklist.push(
      `skalerbarhet ved sesongtopper: gi leverandørens konkrete avklaring og forplikt nå kapasitetsmodell, autoskalering eller eksplisitt dimensjonert kapasitet med reservekapasitet, last- og ytelsestest og de tre operasjonene logge inn, åpne arbeidsliste og lagre endring; bruk Ateas tilbudte leverandørbaseline eksakt (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}) for de samme operasjonene som bindende akseptansekriterium, og merk både målet og lastprofilen som Ateas leverandørforutsetning, ikke kundekrav fra kilden. Bare kundens endelige toppvolum kan stå som ukjent; ikke utsett baseline, test, margin eller akseptansekriterium`,
    );
  }

  if (isStructuredExportPortabilityRequirement(requirement)) {
    checklist.push(
      "strukturert eksport og portabilitet: angi nå minst ett navngitt maskinlesbart eksportformat, for eksempel CSV, JSON, XML, NDJSON/JSONL, Parquet eller XLSX; angi faste felt og identifikatorer og relevant dataomfang for revisjon eller leverandørbytte, levert uten manuell sammenstilling",
    );
  }

  if (isTimedReminderControlRequirement(requirement)) {
    checklist.push(
      "tidsstyrte påminnelser: angi regel og trigger med tidspunkt, frist eller intervall, relevante objekter og roller/mottakere, logget utsendelse og status, samt oppfølging av manglende respons eller avvik med eskalering",
    );
  }

  const realtimeCoordination = realtimeCoordinationRequirementProfile(requirement);
  if (realtimeCoordination?.capability === "avviksbehandling") {
    checklist.push(
      `sanntids avvikskoordinering: bind registrering, statusendring, ansvar og varsling eksplisitt til ${joinNorwegianList(realtimeCoordination.objects)}; forklar hvordan berørte brukere ser og håndterer avvikene operativt, med sporbar hendelses- og statushistorikk`,
    );
  }
  if (realtimeCoordination?.capability === "selvbetjening") {
    checklist.push(
      `sanntids selvbetjening: bind konkrete registrer-, oppdater- og følg-handlinger eksplisitt til ${joinNorwegianList(realtimeCoordination.objects)}, med ansvarlig rolle eller brukergruppe, tilgangsavgrensning, datavalidering og sporbar logging`,
    );
  }

  if (isHistoricalMigrationValidationRequirement(requirement)) {
    checklist.push(
      "historisk migrering: angi feltmapping, testmigrering eller testlast, validering og avviksrapport før produksjonssetting, samt korrigering, retest og godkjenning; ikke utsett mapping eller datakvalitetsavvik til design eller avklaring",
    );
  }

  if (isAuditChangeLogRequirement(requirement)) {
    checklist.push(
      "auditlogg for endringer: angi eksplisitt bruker- eller tjenesteidentitet, tidspunkt, gammel verdi og ny verdi for hver logget endring",
    );
  }

  if (isBackupRestoreVerificationRequirement(requirement)) {
    checklist.push(
      "backup og gjenoppretting: forplikt en dokumentert backup-rutine for produksjonsdata med ansvarlig driftsrolle, jobbkontroll og avviksvarsling; angi kontrollert restore/gjenoppretting, integritetsverifikasjon med kontrollsummer og objekttelling, dokumentert restore-test, loggede avvik, korrigerende tiltak og retest; bind frekvens, oppbevaringstid, RTO/RPO og testkalender i en dataklassebasert backupmatrise som godkjennes før produksjonssetting. Ikke dikt verdier og ikke skyv parameterbeslutningen til designfasen",
    );
  }

  if (isAcceptanceTestCoverageRequirement(requirement)) {
    checklist.push(
      "akseptansetest: dekk brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer, med forventede resultater, avvikslogg, ansvarlig tiltak, retest og testoppsummering eller godkjenning; når kilderaden sier at kravet gjelder produksjonsløsningen, bekreft at testen verifiserer produksjonsløsningens godkjente konfigurasjon i et produksjonslikt testmiljø",
    );
  }

  const permitsExplicitSupplierPerformanceTarget =
    isNoMaterialSlownessDimensioningRequirement(requirement) &&
    documentedPerformanceTargets(entry).length === 0;
  return checklist.length
    ? `Bindende sjekkliste for ${
        requiresExpandedRequirementAnswer(requirement) ? "2–4" : "1–2"
      } setninger: ${checklist.join("; ")}. ${
        permitsExplicitSupplierPerformanceTarget
          ? `Ikke dikt kundetall: bare den konfigurerte leverandørbaselinen (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}) er tillatt, og både responstid og lastprofil må merkes som Ateas tilbudte leverandørforutsetning og ikke som innhold fra kilden. Ikke angi andre ytelsestall, kundedata eller kundespesifikke endepunkter.`
          : "Ikke dikt tall, kundedata eller kundespesifikke endepunkter."
      }`
    : "";
}

const REQUIREMENT_REPAIR_ISSUE_DIRECTIVES: Record<string, string> = {
  missing_concrete_api_pattern:
    "konkret versjonert REST-API over HTTPS eller like konkret produktnøytralt utvekslingsmønster",
  missing_concrete_authentication_pattern:
    "konkret OAuth 2.0/OIDC-, klientlegitimasjons- eller tjenesteidentitetsmønster",
  missing_concrete_data_model_pattern:
    "minst to navngitte, kravrelevante objekter eller dataelementer, identifikator/nøkkelfelt, feltmapping og validering for alle integrasjonsmål; udokumenterte felt, dataeierskap og synkretning må merkes som foreslått integrasjonskontrakt, ikke kundefakta",
  incomplete_api_integration_contract:
    "en komplett foreslått integrasjonskontrakt med navngitte operasjoner, begrensede scopes/rettigheter, konkret masterdataansvar og synkretning, navngitt feltmapping og eksplisitt avvisning eller avvikshåndtering for manglende, ugyldige eller konfliktende data",
  incomplete_identity_crm_api_contract:
    "separate, semantisk riktige kontrakter: ID-porten som OIDC Authorization Code med PKCE, tokenvalidering og identitetsclaims/datamodell, og CRM som versjonert REST-API med klientlegitimasjon, begrensede scopes og navngitte CRUD-operasjoner; bind objekter, nøkkelfelt, feltmapping, autoritativt system, synkretning og feilhåndtering til begge uten å fremstille forslag som kundefakta",
  incomplete_payment_api_contract:
    "en foreslått betalingskontrakt med betalingstransaksjon, kurspåmelding, deltakerkobling og oppgjør; transaksjons-ID, påmeldings-ID og deltaker-ID; feltmapping av beløp, valuta, betalingsstatus, tidsstempel, feilkode og oppgjørsreferanse; konkret autoritativt ansvar, synkretning, validering og feilkø uten å fremstille forslaget som kundefakta",
  incomplete_lms_api_contract:
    "en foreslått LMS-kontrakt med kurs, kursgjennomføring, deltaker, prøve, resultat og sertifikat; kurs-ID, gjennomførings-ID, deltaker-ID, prøve-ID og sertifikat-ID; feltmapping av påmeldingsstatus, poengsum, beståttstatus og gyldighetsperiode; konkret autoritativt ansvar, synkretning, validering og feilkø uten å fremstille forslaget som kundefakta",
  missing_external_sharing_pattern:
    "konkret delingskanal med autentisering, dataavgrensning og logging",
  missing_data_validation_control:
    "obligatoriske felt, format-/regelkontroll og avvisning eller flagging av feil",
  missing_test_method:
    "representative testdata, testscenarier, forventede resultater og dokumentert avviksoppfølging",
  attachment_only_requirement_answer:
    "et selvstendig hovedsvar med konkret leveranse, kontroll og verifikasjon; en vedleggs- eller bilagreferanse kan bare være supplerende og kan ikke bære nødvendig kravdekning",
  missing_direct_in_solution_workflow:
    "oppgaver, registrering og oppfølging utføres direkte i løsningen",
  missing_single_source_registration:
    "data registreres én gang i et felles datagrunnlag og gjenbrukes eller synkroniseres via integrasjoner",
  does_not_eliminate_manual_spreadsheets:
    "manuelle regneark brukes ikke; ikke nøye deg med at behovet bare reduseres",
  missing_no_manual_spreadsheet_user_binding:
    "navngi hver brukergruppe fra kilderaden og bind dem til den direkte arbeidsflyten i løsningen",
  missing_duplicate_safe_integration_control:
    "minst én duplikatsikker mekanisme: idempotens/idempotensnøkkel, deduplisering eller duplikatkontroll; korrelasjons-ID alene er ikke tilstrekkelig",
  missing_recovery_loss_control:
    "minst én recovery-/tapsmekanisme: varig kø, outbox/inbox, checkpoint, dead-letter/feilkø eller avstemming/reconciliation",
  missing_queue_retry_traceability:
    "kø, kontrollert retry/nykjøring og sporbar logging",
  incomplete_identity_crm_lossless_contract:
    "skill ID-portens synkrone OIDC-innlogging, som ikke køes/replayes eller lagrer domeneendring ved feil, fra CRM-opprettelse/-oppdatering med varig outbox, idempotensnøkkel, retry, dead-letter-kø og checkpoint; bruk korrelasjons-ID, hendelseslogg og avstemming for kurs, prøver, sertifikater og deltakerprofiler",
  incomplete_lifecycle_status_contract:
    "konkrete foreslåtte standardstatuser og hovedoverganger for hvert av kurs, prøver, sertifikater og deltakerprofiler, med ansvarlig rolle, tidsstempel og historikk; skill standardmodellen i leveransen fra kundespesifikke konfigurasjonsregler uten designfaseutsettelse",
  incomplete_offline_tender_workflow:
    "uttrykkelig offline-dekning for påmelding, eksamensbesvarelse/prøveresultat og sertifikatgrunnlag eller tidligere utstedt sertifikatbevis, med kryptert lokal kø, idempotensnøkkel, bruker-/enhetsidentitet, tidsstempel, ordnet synkronisering, konfliktkontroll, nykjøring og avvikslogg",
  incomplete_low_latency_tender_contract:
    `bind påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat til Ateas tilbudte baseline ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}, merket som leverandørforutsetning, med last-/ytelsestest, p95-overvåking, varsling, avviksoppfølging, kapasitet og skalering; bevar bare opsjon, designfase, behovsnotat og prioritet når disse finnes i kilderaden`,
  missing_response_time_measurement_points:
    "konkrete målepunkter, percentiler eller navngitte brukertransaksjoner uten oppdiktede terskler",
  missing_response_time_alert_followup:
    "varsling og dokumentert oppfølging eller eskalering av responstidsavvik",
  missing_access_role_least_privilege:
    "rollemodell eller rollebasert tilgang med minste privilegium",
  missing_access_data_scope:
    "dataavgrensning per brukergruppe, datatype, felt eller objekt",
  missing_notification_event_triggers:
    "minst to konkrete varseltriggere, for eksempel opprettelse eller tildeling, statusendring, fristbrudd, manglende respons, samtykkeendring eller avvik",
  missing_notification_delivery_channel:
    "minst én konkret leveringskanal som varsel i løsningen, e-post, SMS eller push",
  missing_notification_recipient_mapping:
    "eksplisitt mapping av varsler til navngitte mottakerroller, for eksempel hvilke varsler frivillige og koordinatorer mottar",
  noncommittal_notification_or_access_control:
    "forplikt varsling, varselmottak og tilgangsstyring positivt i presens, uten negasjon, opsjon, tilvalg eller 'ved behov'",
  missing_capacity_baseline:
    "kapasitetsmodell eller baseline basert på volum-/lastprofil eller samtidighet",
  missing_load_performance_test:
    "last-, belastnings- eller ytelsestest",
  missing_scaling_capacity_margin:
    "enten skalering/autoskalering eller eksplisitt dimensjonert/provisjonert kapasitet, alltid med reservekapasitet eller kapasitetsmargin",
  missing_proposed_performance_acceptance:
    "ytelsesmål og akseptansekriterier som forpliktes nå",
  missing_supplier_proposed_numeric_performance_target:
    `den konfigurerte leverandørbaselinen eksakt (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}), bundet i samme setning til de samme transaksjonene og akseptansekriteriet og uttrykkelig merket som Ateas tilbudte responstidsmål og lastforutsetning, ikke som kundekrav fra kilden; ingen andre ytelsestall`,
  undocumented_performance_target:
    "fjern alle ytelsestall som verken er dokumentert i kilderaden eller er den eksakte konfigurerte leverandørbaselinen som bare brukes når kilden mangler måltall",
  missing_end_to_end_traceability_performance_binding:
    "ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og logging, bundet til minst tre konkret navngitte brukertransaksjoner, ytelsesmåling og de samme responstidsmålene/akseptansekriteriene",
  missing_dimensioning_source_focus_binding:
    "bind kapasitetsmodell, ytelsestest og måltall til den konkrete dimensjoneringsgjenstanden og arbeidsflyten i kilderaden; ikke erstatt den med et annet standardforløp",
  missing_dimensioning_option_qualifier:
    "bevar kildens opsjonsstatus uttrykkelig, for eksempel 'som separat priset opsjon med tydelig avgrensning fra basisleveransen'",
  missing_dimensioning_production_scope:
    "bevar kildens eksplisitte produksjonsscope ved å si at dimensjoneringen gjelder produksjonsløsningen",
  missing_dimensioning_design_phase_qualifier:
    "bevar kildens designfasekvalifikator uttrykkelig; teknisk kjerneomfang forpliktes nå, mens bare eksakte volum-/lastparametere kan valideres i designfasen",
  missing_dimensioning_documentation_qualifier:
    "bevar at dokumentasjon er ønsket ved å forplikte dokumentasjon av lastprofil, testresultat og akseptansekriterier",
  missing_dimensioning_solution_proposal_qualifier:
    "bevar 'Krever løsningsforslag' med en positiv klausul som 'I løsningsforslaget dimensjonerer og forplikter Atea ...'",
  missing_dimensioning_supplier_response_qualifier:
    "bevar 'Besvares av leverandør' med en positiv klausul som 'I leverandørbesvarelsen dimensjonerer og forplikter Atea ...'",
  missing_dimensioning_clarification_qualifier:
    "bevar at kilderaden krever en leverandøravklaring; gi et konkret tilbudt mål nå og avgrens avklaringen til endelig volum-/lastprofil",
  missing_dimensioning_assumption_qualifier:
    "bevar kildens uttrykkelige forutsetning og si hva som forutsettes, uten å gjøre den om til et ubetinget kundekrav",
  missing_dimensioning_note_qualifier:
    "bevar at teksten er et notat fra behovsarbeidet og presenter ytelsesmålet som leverandørens tilbudte løsningsforutsetning, ikke som et bindende kundekrav",
  incomplete_employee_mobile_dimensioning_scope:
    "bekreft at dimensjonering og responstidsmålet gjelder alle ansattefunksjoner og arbeidsflater på mobil og nettbrett; merk de tre navngitte operasjonene som representative kritiske akseptansetransaksjoner og ikke en avgrensning av leveranseomfanget; mål og avtal faktisk topprofil og enhets-/nettlesermatrise med kunden før produksjonssetting, og håndter vesentlige avvik som en dokumentert kapasitet- og prisforutsetning uten å dikte kundevolum eller love ubegrenset kapasitet",
  missing_concrete_machine_readable_export_format:
    "minst ett navngitt maskinlesbart eksportformat nå, for eksempel CSV, JSON, XML, NDJSON/JSONL, Parquet eller XLSX, med faste felt og identifikatorer og relevant dataomfang for revisjon eller leverandørbytte uten manuell sammenstilling",
  incomplete_timed_reminder_control:
    "regel og trigger med tidspunkt, frist eller intervall, relevante objekter og roller/mottakere, logget utsendelse og status, samt oppfølging av manglende respons eller avvik med eskalering",
  missing_realtime_coordination_source_binding:
    "bind alle beskrevne handlinger eksplisitt til hvert navngitt objekt i kilderadens sanntidskoordinering; ikke erstatt dem med generiske oppgaver, status eller avvik",
  incomplete_historical_migration_control:
    "feltmapping, testmigrering eller testlast, validering og avviksrapport før produksjonssetting, etterfulgt av korrigering, retest og godkjenning",
  incomplete_audit_change_log:
    "eksplisitt bruker- eller tjenesteidentitet, tidspunkt, gammel verdi og ny verdi for hver auditlogget endring",
  incomplete_backup_restore_verification:
    "dokumentert backup-rutine for produksjonsdata med ansvarlig driftsrolle, jobbkontroll og avviksvarsling; kontrollert restore/gjenoppretting, integritetsverifikasjon med kontrollsummer og objekttelling, dokumentert restore-test, loggede avvik, korrigerende tiltak og retest; en dataklassebasert backupmatrise der frekvens, oppbevaringstid, gjenopprettingsmål (RTO/RPO) og testkalender bindes og godkjennes før produksjonssetting, uten oppdiktede verdier eller designfaseutsettelse",
  missing_documented_backup_continuity_target:
    "alle tallfestede RTO-/RPO-mål fra kravtekst eller radutdrag, med samme verdi og enhet som i kilden og en positiv leveranseforpliktelse",
  incomplete_acceptance_test_coverage:
    "alle fem områdene brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer, med forventede resultater, avvikslogg, ansvarlig tiltak, retest og testoppsummering eller godkjenning",
  missing_acceptance_production_configuration:
    "verifisering av produksjonsløsningens godkjente konfigurasjon i et produksjonslikt testmiljø når kilderaden sier at kravet gjelder produksjonsløsningen",
  deferred_core_scope:
    `forplikt alle tekniske kjerneelementer i presens nå og ikke avklar eller utsett kjerneomfanget. For dimensjoneringskrav betyr det kapasitetsmodell eller baseline, last-/ytelsestest, skalering eller eksplisitt dimensjonert/provisjonert kapasitet og reservekapasitet/kapasitetsmargin; når kunden ikke har oppgitt tall, skal den konfigurerte baselinen (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}) tilbys eksakt som akseptansekriterium nå og merkes som leverandørforslag og leverandørforutsetning, uten andre ytelsestall og uten å utsettes som en åpen avklaring`,
};

const CANONICAL_LIFECYCLE_DIMENSIONING_REQUIREMENT =
  "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";

const DETERMINISTIC_CONTROL_REPAIR_MANUAL_REVIEW_NOTE =
  "Deterministisk kontrolltekst er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.";

export function buildRequirementRepairDirective(
  entry: RequirementLedgerEntry,
  rejectionReason = "",
) {
  const structure = mandatoryRequirementAnswerStructure(entry);
  if (!structure) {
    return "";
  }

  const missing = Object.entries(REQUIREMENT_REPAIR_ISSUE_DIRECTIVES)
    .filter(([issue]) => rejectionReason.includes(issue))
    .map(([, directive]) => directive);
  return [
    structure,
    missing.length
      ? `Forrige svar manglet spesielt: ${missing.join("; ")}. Alle punktene må være synlige i det nye svaret.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function deterministicBackupSourceResidual(entry: RequirementLedgerEntry) {
  return deterministicControlSourceResidual(
    entry,
    new Set<DeterministicSourceQualifier>([
      "production",
      "designPhase",
      "solutionProposal",
      "needsNote",
    ]),
  );
}

function deterministicControlRepairContextIsSafe(
  entry: RequirementLedgerEntry,
) {
  const context = normalizeRequirementLedgerText(
    [
      entry.id,
      entry.heading,
      entry.service,
      entry.tableId,
      entry.documentTitle,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return !/\b(?:opsjon\w*|tilvalg\w*|valgfri\w*|kun\s+ved\s+(?:særskilt\s+)?bestilling|særskilt\s+bestilling|prises?\w*|pristillegg\w*|grunnpris\w*|ikke\s+inkludert|separat|kommersiell\w*|forbehold\w*|avklar\w*|designfase\w*|produksjonsløsning\w*|løsningsforslag\w*|dokumentasjon\s+ønskes|besvares\s+av\s+leverandør|notat\s+fra\s+behovsarbeidet|prioritet\s*[:：]?\s*(?:bør|kan)|bør|kan|etter\s+(?:kontrakt|kontraktsinngåelse|tildeling|kundens\s+(?:valg|beslutning)|nærmere\s+avtale)|forutsett\w*|særskilt\s+godkjenning|før\s+forpliktelse|testmiljø\w*|skal\s+ikke\s+leveres|bør-?krav\w*|kan-?krav\w*)\b/i.test(
    context,
  );
}

function deterministicLowLatencyOptionContextIsSafe(
  entry: RequirementLedgerEntry,
) {
  if (
    normalizeRequirementLedgerText(entry.heading) !== "åpne avklaringer" ||
    normalizeRequirementLedgerText(entry.id) !== "fun-66" ||
    normalizeRequirementLedgerText(entry.tableId ?? "") !== "docx tabell 6"
  ) {
    return false;
  }
  const remainingContext = normalizeRequirementLedgerText(
    [entry.id, entry.service, entry.tableId, entry.documentTitle]
      .filter(Boolean)
      .join(" "),
  );
  return !/\b(?:opsjon\w*|tilvalg\w*|valgfri\w*|prises?\w*|pristillegg\w*|ikke\s+inkludert|separat|kommersiell\w*|forbehold\w*|designfase\w*|produksjonsløsning\w*|løsningsforslag\w*|etter\s+(?:kontrakt|tildeling)|testmiljø\w*)\b/iu.test(
    remainingContext,
  );
}

function deterministicLifecycleClarificationContextIsSafe(
  entry: RequirementLedgerEntry,
) {
  if (
    normalizeRequirementLedgerText(entry.id) !== "avklaringskrav-07" ||
    normalizeRequirementLedgerText(entry.heading) !== "åpne avklaringer" ||
    normalizeRequirementLedgerText(entry.tableId ?? "") !== "dokumenttekst"
  ) {
    return false;
  }
  const remainingContext = normalizeRequirementLedgerText(
    [entry.service, entry.documentTitle].filter(Boolean).join(" "),
  );
  return !/\b(?:opsjon\w*|tilvalg\w*|valgfri\w*|prises?\w*|pristillegg\w*|ikke\s+inkludert|separat|kommersiell\w*|forbehold\w*|designfase\w*|produksjonsløsning\w*|løsningsforslag\w*|etter\s+(?:kontrakt|tildeling)|testmiljø\w*)\b/iu.test(
    remainingContext,
  );
}

function deterministicSeasonalScalabilityContextIsSafe(
  entry: RequirementLedgerEntry,
) {
  if (
    entry.id !== "Avklaringskrav-06" ||
    normalizeRequirementLedgerText(entry.heading) !==
      normalizeRequirementLedgerText("Uavklarte, men viktige punkter") ||
    normalizeRequirementLedgerText(entry.tableId ?? "") !==
      normalizeRequirementLedgerText("Dokumenttekst") ||
    !isSeasonalScalabilityClarificationRequirement(entry.text)
  ) {
    return false;
  }
  const flags = deterministicControlSourceFlags(entry);
  if (
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["clarification"]),
    ) !== "" ||
    !flags.clarification ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    flags.assumption ||
    flags.needsNote
  ) {
    return false;
  }
  const remainingContext = normalizeRequirementLedgerText(
    [entry.service, entry.documentTitle].filter(Boolean).join(" "),
  );
  return !/\b(?:opsjon\w*|tilvalg\w*|valgfri\w*|prises?\w*|pristillegg\w*|ikke\s+inkludert|separat|kommersiell\w*|forbehold\w*|designfase\w*|produksjonsløsning\w*|løsningsforslag\w*|etter\s+(?:kontrakt|tildeling)|testmiljø\w*)\b/iu.test(
    remainingContext,
  );
}

function deterministicDimensioningSourceResidual(
  entry: RequirementLedgerEntry,
) {
  return deterministicControlSourceResidual(
    entry,
    new Set<DeterministicSourceQualifier>([
      "production",
      "solutionProposal",
    ]),
  );
}

function buildProfiledDimensioningTemplate(entry: RequirementLedgerEntry) {
  const profile = dimensioningOperationProfile(entry.text);
  const qualifiers = deterministicControlSourceFlags(entry);
  if (!profile) {
    return null;
  }
  if (
    normalizeRequirementLedgerText(entry.text) ===
    normalizeRequirementLedgerText(CANONICAL_LIFECYCLE_DIMENSIONING_REQUIREMENT)
  ) {
    const template = qualifiers.production
      ? DETERMINISTIC_PRODUCTION_DIMENSIONING_TEMPLATE_REPAIR
      : DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR;
    return qualifiers.priority && qualifiers.priority !== "Må"
      ? `Raden har prioritet «${qualifiers.priority}». ${template}`
      : template;
  }

  const securityBinding =
    normalizeComparableText(profile.focus) ===
    normalizeComparableText("sikker datadeling med eksterne aktører")
      ? " gjennom en sikker portal med OIDC-basert tjenesteidentitet, minste privilegium, dataavgrensning og sporbar logging"
      : "";
  const lead = qualifiers.production
    ? "I løsningsforslaget for produksjonsløsningen dimensjonerer og forplikter Atea"
    : qualifiers.solutionProposal
      ? "I løsningsforslaget dimensjonerer og forplikter Atea"
      : "Atea dimensjonerer og forplikter";
  const coversCompleteEmployeeMobileSurface =
    normalizeComparableText(profile.focus) ===
    normalizeComparableText("tilgjengelighet for ansatte på mobil og nettbrett");
  const operationScope = coversCompleteEmployeeMobileSurface
    ? ` for alle ansattefunksjoner og arbeidsflater; operasjonene ${joinNorwegianList(profile.operations)} er representative kritiske akseptansetransaksjoner og ikke en avgrensning av leveranseomfanget`
    : ` for operasjonene ${joinNorwegianList(profile.operations)}`;
  const acceptanceScope = coversCompleteEmployeeMobileSurface
    ? "for hele ansatteflaten og de samme operasjonene"
    : "for de samme operasjonene";
  const customerProfileValidation = coversCompleteEmployeeMobileSurface
    ? " Før produksjonssetting måler Atea de faktiske arbeidsflytene og validerer topprofilen samt enhets- og nettlesermatrisen sammen med kunden som en uttrykkelig avtalt akseptanse- og dimensjoneringsprofil; leverandørbaselinen er inkludert som minste dimensjoneringsgrunnlag og er ikke fremstilt som kundens volum, mens vesentlige avvik dokumenteres som en kapasitet- og prisforutsetning som må godkjennes før produksjonssetting."
    : "";
  const template = `${lead} ${profile.focus}${securityBinding}${operationScope} etter en kapasitetsmodell og ytelsesbaseline som verifiseres med last- og ytelsestest samt provisjonert kapasitet med eksplisitt reservekapasitet. Ateas tilbudte responstidsmål er ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE} ${acceptanceScope}; både målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og brukes som bindende akseptansekriterium før produksjonssetting.${customerProfileValidation}`;
  return qualifiers.priority && qualifiers.priority !== "Må"
    ? `Raden har prioritet «${qualifiers.priority}». ${template}`
    : template;
}

export function buildDeterministicFinalRequirementTemplateRepair(input: {
  entry: RequirementLedgerEntry;
  evidence?: string;
}): RequirementAnswerResult | null {
  const qualifiers = deterministicControlSourceFlags(input.entry);
  if (
    !isCanonicalSinglePurposeProfiledDimensioningRequirement(input.entry) ||
    documentedPerformanceTargets(input.entry).length !== 0 ||
    deterministicDimensioningSourceResidual(input.entry) !== "" ||
    !deterministicControlRepairContextIsSafe(input.entry) ||
    qualifiers.option ||
    qualifiers.designPhase ||
    qualifiers.documentation ||
    qualifiers.supplierResponse ||
    qualifiers.clarification ||
    qualifiers.assumption ||
    qualifiers.needsNote
  ) {
    return null;
  }

  const template = buildProfiledDimensioningTemplate(input.entry);
  if (
    !template ||
    !deterministicDynamicControlCopyReflectsSource(input.entry, template)
  ) {
    return null;
  }

  const normalized = normalizeRequirementAnswerResult(
    template,
    input.entry,
    input.evidence,
  );
  if (
    normalized.source === "deterministic_fallback" ||
    normalized.answer !== template
  ) {
    return null;
  }

  return {
    ...normalized,
    source: "deterministic_template_repair",
  };
}

function normalizeRequirementCoverageAssessment(
  value: unknown,
): RequirementCoverageItem["assessment"] {
  if (
    value === "Godt" ||
    value === "Dårlig" ||
    value === "Mangler" ||
    value === "Uklart"
  ) {
    return value;
  }

  return "Uklart";
}

/** Pages of the solution document that hold an entry's answer. A merged
 * entry keeps the *customer* document's pages, which must never be applied
 * to Bilag 2 (DOCX requirements all report page 1, so Bilag 2's summary page
 * was selected for every requirement). */
function solutionAnswerPages(
  entry: RequirementLedgerEntry,
  document: ProjectDocumentDetail,
) {
  if (entry.documentId === document.id) return entry.pages;
  const answer = normalizeQuoteMatchText(entry.answerExcerpt ?? "").slice(0, 60);
  if (answer.length < 24 || document.file_format !== "pdf") return [];
  return normalizedSolutionText(document)
    .pages.filter((page) => page.text.includes(answer))
    .map((page) => page.page);
}

// Exported for the page-selection regression test.
// fallow-ignore-next-line unused-export
export function buildRequirementCoveragePageContext(input: {
  document: ProjectDocumentDetail;
  entries: RequirementLedgerEntry[];
}) {
  const wantedPages = new Set<number>();
  for (const entry of input.entries) {
    for (const page of solutionAnswerPages(entry, input.document)) {
      if (page > 1) {
        wantedPages.add(page - 1);
      }
      wantedPages.add(page);
      wantedPages.add(page + 1);
    }
  }

  if (!wantedPages.size) {
    return "";
  }

  const pages =
    input.document.file_format === "pdf"
      ? splitPdfPagesPreservingLines(input.document.raw_text)
      : [{ page: 1, text: input.document.raw_text }];
  const selected = pages
    .filter((page) => wantedPages.has(page.page))
    .slice(0, 4);

  if (!selected.length) {
    return "";
  }

  return buildDelimitedContext(
    "Sider rundt kravene i Bilag 2",
    selected
      .map((page) =>
        [
          `${input.document.title} – side ${page.page}`,
          compactText(page.text, 520),
        ].join("\n"),
      )
      .join("\n\n"),
  );
}

function buildRequirementCoverageExactRowContext(
  entries: RequirementLedgerEntry[],
  startIndex = 0,
) {
  const rows = entries
    .map((entry, localIndex) => ({
      nr: startIndex + localIndex + 1,
      ref: requirementCoverageIdentityRef(entry),
      source_document_id: entry.documentId,
      answer_document_id: entry.answerDocumentId,
      source_excerpt: entry.sourceExcerpt
        ? compactText(entry.sourceExcerpt, 1100)
        : undefined,
      answer_excerpt: entry.answerExcerpt
        ? compactText(entry.answerExcerpt, 700)
        : undefined,
    }))
    .filter((row) => row.source_excerpt || row.answer_excerpt);

  if (!rows.length) {
    return "";
  }

  return buildDelimitedContext(
    "Eksakte kravradutdrag og svarutdrag fra Bilag 2",
    JSON.stringify(rows),
  );
}

function entryHasCompleteExactEvidence(entry: RequirementLedgerEntry) {
  const sourceExcerpt = (entry.sourceExcerpt ?? "").replace(/\s+/g, " ").trim();
  const answerExcerpt = (entry.answerExcerpt ?? "").replace(/\s+/g, " ").trim();
  const substantiveAnswer = substantiveRequirementAnswerExcerpt(entry);

  return (
    sourceExcerpt.length >= 20 &&
    answerExcerpt.length >= 24 &&
    substantiveAnswer.length >= 24 &&
    !/^(?:ja|nei|yes|no)[.!]?$/i.test(substantiveAnswer)
  );
}

export function coverageBatchHasCompleteExactEvidence(
  entries: RequirementLedgerEntry[],
) {
  return entries.length > 0 && entries.every(entryHasCompleteExactEvidence);
}

const REQUIREMENT_COVERAGE_HITS_PER_REQUIREMENT = 2;
const REQUIREMENT_COVERAGE_SNIPPET_CHARS = 900;
const REQUIREMENT_COVERAGE_RETRIEVAL_CHAR_BUDGET = 12_000;
const REQUIREMENT_COVERAGE_RETRIEVAL_CONCURRENCY = 3;

/**
 * Returns whole sentences around the part of a chunk that best matches the
 * requirement, instead of the chunk's first characters. Neighbouring
 * sentences are kept so negations, numbers and qualifications survive.
 */
export function matchCenteredExcerpt(text: string, query: string, limit: number) {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= limit) return clean;
  const sentences = clean.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((part) => part.trim()).filter(Boolean) ?? [clean];
  // Distinctive terms only: generic words ("Leverandøren", "beskrive") would
  // otherwise anchor the window on introductory text.
  const queryTerms = distinctiveTerms(query);
  const terms = [...queryTerms.strong, ...queryTerms.stems];
  const score = (sentence: string) => {
    const normalized = normalizeQuoteMatchText(sentence);
    return terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
  };
  let best = 0;
  sentences.forEach((sentence, index) => {
    if (score(sentence) > score(sentences[best]!)) best = index;
  });
  const bestSentence = sentences[best]!;
  if (bestSentence.length >= limit) {
    // One long sentence: pick the window holding the most distinct terms.
    const normalized = normalizeQuoteMatchText(bestSentence);
    const hits = terms.flatMap((term) =>
      [...normalized.matchAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))].map((match) => ({ term, at: match.index! })),
    );
    let from = 0;
    let bestCount = -1;
    for (const { at } of hits) {
      const candidate = Math.max(0, Math.min(at - Math.floor(limit / 4), bestSentence.length - limit));
      const count = new Set(
        hits.filter((hit) => hit.at >= candidate && hit.at < candidate + limit).map((hit) => hit.term),
      ).size;
      if (count > bestCount) {
        bestCount = count;
        from = candidate;
      }
    }
    return bestSentence.slice(from, from + limit).trim();
  }
  // Grow around the matching sentence: the preceding sentence first (it often
  // carries a negation or condition), then following ones, while they fit.
  let start = best;
  let end = best + 1;
  const length = () => sentences.slice(start, end).join(" ").length;
  if (start > 0 && length() + sentences[start - 1]!.length + 1 <= limit) start -= 1;
  while (end < sentences.length && length() + sentences[end]!.length + 1 <= limit) end += 1;
  while (start > 0 && length() + sentences[start - 1]!.length + 1 <= limit) start -= 1;
  return sentences.slice(start, end).join(" ");
}

async function buildPerRequirementRetrievalContext(input: {
  entries: RequirementLedgerEntry[];
  solutionDocument: ProjectDocumentDetail;
  startIndex: number;
}) {
  const targets = input.entries
    .map((entry, localIndex) => ({ entry, nr: input.startIndex + localIndex + 1 }))
    .filter(({ entry }) => !entryHasCompleteExactEvidence(entry));
  if (!targets.length) return "";
  const results = await mapWithConcurrency(
    targets,
    REQUIREMENT_COVERAGE_RETRIEVAL_CONCURRENCY,
    async ({ entry, nr }) => {
      const query = [entry.id, entry.heading, entry.text].filter(Boolean).join(" ");
      const snippets = await retrieveDocumentSnippets({
        query,
        documents: [input.solutionDocument],
        exactTerms: entry.id && !isSyntheticRequirementId(entry.id) ? [entry.id] : [],
        limit: REQUIREMENT_COVERAGE_HITS_PER_REQUIREMENT,
      });
      // Centre each hit on this requirement before any deduplication, so a
      // shared chunk still shows the part that answers each requirement.
      return snippets.map((snippet) => {
        const page = snippet.pageStart
          ? `side ${snippet.pageEnd && snippet.pageEnd !== snippet.pageStart ? `${snippet.pageStart}-${snippet.pageEnd}` : snippet.pageStart}`
          : "";
        return {
          nr,
          label: [snippet.documentTitle, page, snippet.headingPath.length ? snippet.headingPath.join(" > ") : ""]
            .filter(Boolean)
            .join(" – "),
          text: matchCenteredExcerpt(snippet.text, query, REQUIREMENT_COVERAGE_SNIPPET_CHARS),
        };
      });
    },
  );

  // Every requirement with hits is guaranteed an equal share of the budget
  // for its best hit; second hits only use what is left. Identical excerpts
  // are shown once, listing every requirement they serve.
  const withHits = results.filter((hits) => hits.length > 0).length;
  const firstHitAllowance = Math.floor(
    REQUIREMENT_COVERAGE_RETRIEVAL_CHAR_BUDGET / Math.max(1, withHits),
  );
  const passages = new Map<string, { nrs: number[]; label: string; text: string }>();
  let used = 0;
  for (let rank = 0; rank < REQUIREMENT_COVERAGE_HITS_PER_REQUIREMENT; rank += 1) {
    for (const hits of results) {
      const hit = hits[rank];
      if (!hit) continue;
      const label = compactText(hit.label, 120);
      const allowance = rank === 0
        ? firstHitAllowance
        : REQUIREMENT_COVERAGE_RETRIEVAL_CHAR_BUDGET - used;
      const text = hit.text.length + label.length + 24 > allowance
        ? compactText(hit.text, Math.max(0, allowance - label.length - 24))
        : hit.text;
      if (text.length < 80) continue;
      const key = normalizeQuoteMatchText(text);
      const existing = passages.get(key);
      if (existing) {
        if (!existing.nrs.includes(hit.nr)) existing.nrs.push(hit.nr);
        continue;
      }
      const blockChars = `Krav nr ${hit.nr} – ${label}\n${text}`.length + 2;
      if (rank > 0 && used + blockChars > REQUIREMENT_COVERAGE_RETRIEVAL_CHAR_BUDGET) continue;
      passages.set(key, { nrs: [hit.nr], label, text });
      used += blockChars;
    }
  }
  if (!passages.size) return "";
  const blocks = [...passages.values()]
    .sort((left, right) => left.nrs[0]! - right.nrs[0]!)
    .map((passage) => `Krav nr ${passage.nrs.join(", ")} – ${passage.label}\n${passage.text}`);
  return buildDelimitedContext("Relevante Bilag 2-utdrag per krav", blocks.join("\n\n"));
}

export async function buildRequirementCoverageRetrievalContext(input: {
  entries: RequirementLedgerEntry[];
  solutionDocument: ProjectDocumentDetail;
  startIndex?: number;
  /** The whole solution document is already in the prompt. */
  fullSolutionDocumentIncluded?: boolean;
}) {
  const exactContext = buildRequirementCoverageExactRowContext(
    input.entries,
    input.startIndex,
  );
  if (input.fullSolutionDocumentIncluded) {
    return exactContext;
  }

  // Exact matched rows already contain both sides of the comparison. Re-running
  // semantic retrieval in that case only repeats the same answer text and nearby
  // pages. Any incomplete row keeps the original retrieval path fail-safe.
  if (coverageBatchHasCompleteExactEvidence(input.entries)) {
    return exactContext;
  }

  // One query for a whole batch returned four 480-character snippets for
  // up to 18 requirements; each incomplete requirement now gets its own hits.
  const semanticContext = await buildPerRequirementRetrievalContext({
    entries: input.entries,
    solutionDocument: input.solutionDocument,
    startIndex: input.startIndex ?? 0,
  });

  return [
    exactContext,
    buildRequirementCoveragePageContext({
      document: input.solutionDocument,
      entries: input.entries,
    }),
    semanticContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizedRequirementCoverageTableId(entry: RequirementLedgerEntry) {
  return normalizePdfReferenceTypography(entry.tableId ?? "");
}

function requirementCoverageRef(entry: RequirementLedgerEntry) {
  const tableId = normalizedRequirementCoverageTableId(entry);
  const service = cleanTableService(serviceFromTableRequirementId(entry));
  if (tableId && /\bTabell\s+ID\s+\d{1,3}-\d{1,3}[A-Z]?\b/i.test(tableId)) {
    if (service) {
      return `${tableId} - ${service}`;
    }

    return tableId;
  }

  return normalizePdfReferenceTypography(
    requirementDisplayRef(entry, requirementGroupHeading(entry)),
  );
}

export function requirementCoverageIdentityRef(entry: RequirementLedgerEntry) {
  const tableId = normalizedRequirementCoverageTableId(entry);
  // These are parser location labels shared by many distinct source rows.
  // Preserve them as locators, while matching answers by the actual row ID.
  if (tableId && !/^Dokumenttekst(?: krav-ID)?$/iu.test(tableId)) {
    return tableId;
  }

  const id = entry.id.replace(/\s+/g, " ").trim();
  return id || requirementCoverageRef(entry);
}

function requirementCoverageSource(entry: RequirementLedgerEntry) {
  return requirementDisplaySource(entry, requirementGroupHeading(entry));
}

export function buildRequirementCoverageBatchRegistry(
  entries: RequirementLedgerEntry[],
  startIndex = 0,
) {
  return entries.map((entry, localIndex) => ({
    nr: startIndex + localIndex + 1,
    ref: requirementCoverageIdentityRef(entry),
    display_ref:
      requirementCoverageIdentityRef(entry) === requirementCoverageRef(entry)
        ? undefined
        : requirementCoverageRef(entry),
    full_reference: requirementFullReference(entry),
    source_reference: requirementCoverageSource(entry),
    source_document_id: entry.documentId,
    source_document_title: entry.documentTitle,
    answer_document_id: entry.answerDocumentId,
    answer_document_title: entry.answerDocumentTitle,
    requirement_subtitle: requirementSubtitle(entry),
    heading_path: requirementHeadingPath(entry),
    page_range: requirementPageRange(entry) || undefined,
    table_id: entry.tableId || null,
    requirement: compactText(entry.text, 900),
  }));
}

export function buildRequirementResponseBatchRegistry(
  entries: RequirementLedgerEntry[],
  startIndex = 0,
) {
  return entries.map((entry, localIndex) => {
    const mandatoryAnswerStructure = buildRequirementRepairDirective(entry);
    const answerExcerpt = substantiveRequirementAnswerExcerpt(entry);
    return {
      nr: startIndex + localIndex + 1,
      ref: requirementDisplayRef(entry, requirementGroupHeading(entry)),
      full_reference: requirementFullReference(entry),
      source_reference: requirementDisplaySource(
        entry,
        requirementGroupHeading(entry),
      ),
      source_document_id: entry.documentId,
      source_document_title: entry.documentTitle,
      answer_document_id: entry.answerDocumentId,
      answer_document_title: entry.answerDocumentTitle,
      requirement_subtitle: requirementSubtitle(entry),
      heading_path: requirementHeadingPath(entry),
      page_range: requirementPageRange(entry) || undefined,
      table_id: entry.tableId || null,
      kravtekst: compactText(entry.text, 900),
      source_excerpt: entry.sourceExcerpt
        ? compactText(entry.sourceExcerpt, 700)
        : undefined,
      answer_excerpt: answerExcerpt
        ? compactText(answerExcerpt, 700)
        : undefined,
      ...(mandatoryAnswerStructure
        ? { obligatorisk_svarstruktur: mandatoryAnswerStructure }
        : {}),
    };
  });
}

export function suppressDuplicatedDocumentLedgerContext(input: {
  documentLedgerContext?: string;
  authoritativeRequirementRegistryPresent: boolean;
}) {
  const context = input.documentLedgerContext?.trim() ?? "";
  if (!context || !input.authoritativeRequirementRegistryPresent) {
    return context;
  }

  let insidePreciseRequirementLedger = false;
  return context
    .split(/\r?\n/)
    .filter((line) => {
      if (/^###\s+Presis kravledger for vurdering\s*$/i.test(line.trim())) {
        insidePreciseRequirementLedger = true;
        return false;
      }
      if (insidePreciseRequirementLedger && /^###\s+/.test(line.trim())) {
        insidePreciseRequirementLedger = false;
      }
      if (insidePreciseRequirementLedger) {
        return false;
      }

      return !/^Kravutdrag:\s*/i.test(line.trim());
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function supplierAnswerNeedsConfirmation(value: string) {
  return answerExplicitlyDeclinesRequirement(value) ||
    answerDefersRequirementConfirmation(value) ||
    /\b(?:ikke\s+priset|må\s+avklares|ikke\s+(?:avklart|bekreftet|avtalt))\b/i.test(value);
}

function coverageTextClaimsMissingAttachmentBackedDetail(value: string) {
  const text = normalizePageText(value);
  return /\b(?:mangler|mangler\s+konkret|uten\s+konkret|fremgår\s+ikke|ikke\s+fremgår|ikke\s+navngitt|navngi|ikke\s+tydelig)\b/i.test(
    text,
  );
}

type HighConfidenceCoveragePattern =
  | "timed_reminder"
  | "historical_migration"
  | "audit_change_log"
  | "backup_restore"
  | "acceptance_test";

export type DeterministicControlRepairPattern =
  | HighConfidenceCoveragePattern
  | "no_manual_spreadsheet"
  | "lossless_queue_retry"
  | "lossless_identity_crm_retry"
  | "lifecycle_status_contract"
  | "offline_tender_workflow"
  | "low_latency_tender_contract"
  | "low_latency_supplier_option"
  | "seasonal_scalability"
  | "structured_export"
  | "api_source_bound"
  | "api_calendar_identity"
  | "api_membership_register"
  | "automatic_notification_access"
  | "dimensioning_supplier_baseline";

const DETERMINISTIC_CONTROL_REPAIR_COPY: Partial<Record<
  DeterministicControlRepairPattern,
  string
>> = {
  timed_reminder:
    "Løsningen bruker en regel for påminnelser som utløses ved planlagt tidspunkt eller frist for relevante oppdrag og sender til ansvarlig rolle eller mottaker; hver utsendelse og status logges. Manglende respons eller avvik følges opp med eskalering.",
  historical_migration:
    "Løsningen gjennomfører feltmapping og testmigrering, validerer resultatet og utarbeider avviksrapport før produksjonssetting. Avvik korrigeres og retestes før godkjenning.",
  audit_change_log:
    "Løsningen registrerer hver endring i en auditlogg med brukeridentitet eller tjenesteidentitet, tidspunkt, gammel verdi og ny verdi. Loggpostene kontrolleres og dokumenteres ved revisjon.",
  backup_restore:
    "Løsningen etablerer og drifter en dokumentert backup-rutine for produksjonsdata om oppdrag, frivillige, samtykker og meldinger, med driftsansvarlig rolle, jobbkontroll og avviksvarsling; frekvens, oppbevaringstid, RTO, RPO og testkalender fastsettes per dataklasse i en backupmatrise som godkjennes før produksjonssetting og gjelder som bindende driftsparametere. Kontrollert gjenoppretting følger dokumentert runbook; dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.",
  acceptance_test:
    "Akseptansetesten verifiserer produksjonsløsningens godkjente konfigurasjon i et produksjonslikt testmiljø og dekker brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, retestes og inngår i testoppsummeringen før godkjenning.",
  no_manual_spreadsheet:
    "Brukere utfører oppgaver, registrering og oppfølging direkte i løsningen, og data registreres én gang i et felles datagrunnlag og gjenbrukes. Manuelle regneark brukes ikke.",
  structured_export:
    "Løsningen leverer alle relevante data som CSV og JSON med faste felt og stabile identifikatorer ved revisjon eller leverandørbytte, uten manuell sammenstilling.",
  api_calendar_identity:
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS med OAuth 2.0-klientlegitimasjon, separate scopes for kalenderlesing, kalenderskriving og identitetslesing, og operasjonene opprett, hent og oppdater. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID og feltmapping av starttid, sluttid, status, e-post og rolle; kalenderen er master for kalenderhendelser, identitetsløsningen er master for brukeridentiteter, og skyplattformen synkroniserer endringer fra hver master, avviser manglende nøkkelfelt og sender ugyldige data eller versjonskonflikter til sporbar feilkø for korrigering og ny kjøring.",
  api_membership_register:
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS mot medlemsregisteret med OAuth 2.0-klientlegitimasjon, separate scopes for medlemslesing og medlemsskriving og operasjonene hent og oppdater. Datamodellen omfatter objektene frivillig og medlemskap med nøkkelfeltene frivillig-ID og medlems-ID og feltmapping av navn, kontaktinformasjon, status, type og gyldighetsperiode; medlemsregisteret er master for begge objektene, og skyplattformen henter endringer fra medlemsregisteret og sender godkjente oppdateringer tilbake til medlemsregisteret, avviser manglende nøkkelfelt og sender ugyldige data eller versjonskonflikter til sporbar avvikslogg for korrigering og ny kjøring.",
  automatic_notification_access:
    "Løsningen sender automatisk varsel ved tildeling av oppdrag, fristbrudd og manglende respons i løsningen og via e-post eller SMS; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd og samtykkeendringer i sakene de følger opp. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne tildelte oppdrag og meldinger, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne oppdrag, meldinger og samtykkeopplysninger.",
  dimensioning_supplier_baseline: DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR,
};

const EXACT_API_CALENDAR_IDENTITY_REQUIREMENT =
  "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.";

const EXACT_API_MEMBERSHIP_REGISTER_REQUIREMENT =
  "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og medlemsregister.";

const EXACT_AUTOMATIC_NOTIFICATION_ACCESS_REQUIREMENT =
  "Løsningen skal ha automatisk varsling slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger for frivillig omsorg og besøksvenner.";

const BACKUP_REFLECTED_SOURCE_QUALIFIERS = new Set<
  DeterministicSourceQualifier
>(["needsNote"]);

function deterministicControlSourceResidual(
  entry: RequirementLedgerEntry,
  allowedQualifiers: ReadonlySet<DeterministicSourceQualifier>,
) {
  return deterministicControlSourceFields(entry, allowedQualifiers).residual;
}

function deterministicStaticControlSourceIsSafe(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  return (
    deterministicControlRepairContextIsSafe(entry) &&
    flags.priority !== "Bør" &&
    flags.priority !== "Kan" &&
    !flags.production &&
    !flags.designPhase &&
    !flags.solutionProposal &&
    !flags.documentation &&
    !flags.supplierResponse &&
    !flags.option &&
    !flags.clarification &&
    !flags.assumption &&
    !flags.needsNote &&
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(),
    ) === ""
  );
}

function deterministicDynamicControlCopyReflectsSource(
  entry: RequirementLedgerEntry,
  copy: string,
  reflectedQualifiers?: ReadonlySet<DeterministicSourceQualifier>,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    flags.option ||
    flags.documentation ||
    flags.supplierResponse ||
    (flags.clarification && !reflectedQualifiers?.has("clarification")) ||
    flags.assumption ||
    (flags.needsNote && !reflectedQualifiers?.has("needsNote"))
  ) {
    return false;
  }
  if (
    flags.priority &&
    flags.priority !== "Må" &&
    !copy.includes(`prioritet «${flags.priority}»`)
  ) {
    return false;
  }
  return (
    (!flags.production || /\bproduksjonsløsning(?:en)?\b/iu.test(copy)) &&
    (!flags.designPhase || /\bi\s+designfasen\b/iu.test(copy)) &&
    (!flags.solutionProposal || /\bi\s+løsningsforslaget\b/iu.test(copy)) &&
    (!flags.clarification ||
      /\bleverandørens\s+konkrete\s+avklaring\b/iu.test(copy)) &&
    (!flags.needsNote || /\bkravraden\s+fra\s+behovsarbeidet\b/iu.test(copy))
  );
}

function deterministicPriorityLead(flags: DeterministicControlSourceFlags) {
  return flags.priority ? `For raden med prioritet «${flags.priority}» ` : "";
}

type SourceBoundApiTarget = {
  label: string;
  key: string;
  comparable: string;
};

function sourceBoundApiTargets(
  entry: RequirementLedgerEntry,
): SourceBoundApiTarget[] | null {
  const requirement = normalizePageText(entry.text);
  const match =
    /^Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og ([^.;:]+)\.?$/iu.exec(
      requirement,
    );
  if (!match?.[1]) {
    return null;
  }
  const labels = match[1]
    .split(/\s*,\s*|\s+(?:og|samt)\s+|\s*\/\s*/iu)
    .map((target) => target.trim())
    .filter(Boolean);
  if (labels.length < 1 || labels.length > 2) {
    return null;
  }

  const targets = labels.map((label) => {
    const comparable = normalizeComparableText(label);
    const tokens = comparable.split(/\s+/u).filter(Boolean);
    if (
      label.length > 48 ||
      tokens.length < 1 ||
      tokens.length > 3 ||
      !/^[\p{L}][\p{L}\p{N}-]*(?:\s+[\p{L}][\p{L}\p{N}-]*){0,2}$/u.test(
        label,
      ) ||
      tokens.some((token) =>
        /^(?:og|eller|samt|med|uten|som|skal|må|kan|beskrive)$/iu.test(token),
      ) ||
      /^(?:data|system|løsning|skyplattform(?:en)?)$/iu.test(comparable)
    ) {
      return null;
    }
    return {
      label,
      comparable,
      key: comparable.replace(/\s+/gu, "-"),
    } satisfies SourceBoundApiTarget;
  });
  if (targets.some((target) => target === null)) {
    return null;
  }
  const parsedTargets = targets as SourceBoundApiTarget[];
  if (
    new Set(parsedTargets.map((target) => target.comparable)).size !==
      parsedTargets.length ||
    apiIntegrationTargets(requirement).join("\u001f") !==
      parsedTargets.map((target) => target.comparable).join("\u001f")
  ) {
    return null;
  }
  return parsedTargets;
}

function joinNorwegianList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} og ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} og ${values.at(-1)}`;
}

function sourceBoundTimedReminderObjects(entry: RequirementLedgerEntry) {
  const match =
    /^Løsningen skal støtte tidsstyrte påminnelser for å gjennomføre sanntids koordinering av ([^.!?;:]+) på en kontrollert og sporbar måte\.?$/iu.exec(
      normalizePageText(entry.text),
    );
  const objects = (match?.[1] ?? "")
    .split(/\s*,\s*|\s+(?:og|samt)\s+/iu)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    objects.length < 2 ||
    objects.length > 6 ||
    objects.some(
      (value) =>
        value.length > 48 ||
        !/^[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2}$/u.test(value) ||
        /\b(?:skal|må|kan|ikke|uten|opsjon|avklar|pris|time|dag|uke|måned|år)\b/iu.test(
          value,
        ),
    )
  ) {
    return null;
  }
  return objects;
}

function buildSourceBoundTimedReminderControlCopy(
  entry: RequirementLedgerEntry,
) {
  const objects = sourceBoundTimedReminderObjects(entry);
  if (
    !objects ||
    !deterministicStaticControlSourceIsSafe(entry)
  ) {
    return null;
  }
  const scope = joinNorwegianList(objects);
  return `Atea leverer en tidsstyrt påminnelsesregel for ${scope} med en trigger ved fast tidspunkt, relativ frist eller intervall og utsendelse til ansvarlig rolle eller mottaker. Hver utsendelse og dens status logges, og manglende respons eller avvik eskaleres til ansvarlig rolle.`;
}

function buildSourceBoundApiControlCopy(entry: RequirementLedgerEntry) {
  const targets = sourceBoundApiTargets(entry);
  const flags = deterministicControlSourceFlags(entry);
  if (
    !targets ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["designPhase", "needsNote"]),
    ) !== "" ||
    flags.production ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    flags.clarification ||
    flags.assumption
  ) {
    return null;
  }

  const needsNotePriority = flags.priority
    ? ` med prioritet «${flags.priority}»`
    : "";
  const offerLead = flags.needsNote
    ? `For kravraden fra behovsarbeidet${needsNotePriority} tilbyr Atea`
    : flags.priority
      ? `${deterministicPriorityLead(flags)}tilbyr Atea`
      : "Atea tilbyr";

  const isPaymentContract =
    targets.length === 1 &&
    targets[0]?.comparable === normalizeComparableText("betalingsløsning");
  if (isPaymentContract) {
    const copy = [
      `${offerLead} som foreslått integrasjonskontrakt et versjonert REST-API over HTTPS mot betalingsløsningen med OAuth 2.0-klientlegitimasjon, separate scopes for betaling-lesing, betaling-opprett og betaling-callback og operasjonene opprett betalingsforespørsel, hent betalingsstatus og behandle statuscallback.`,
      "Den foreslåtte datamodellen omfatter objektene betalingstransaksjon, kurspåmelding, deltakerkobling og oppgjør med nøkkelfeltene transaksjons-ID, påmeldings-ID og deltaker-ID og feltmapping av beløp, valuta, betalingsstatus, tidsstempel, feilkode og oppgjørsreferanse.",
      "Skyplattformen er autoritativ for kurspåmelding og deltakerkobling, betalingsløsningen er autoritativt system for betalingstransaksjon, betalingsstatus og oppgjør; skyplattformen sender betalingsforespørsel med påmeldings- og deltakerreferanse og mottar statuscallback og oppgjørsstatus.",
      "Integrasjonen validerer nøkkelfelt, beløp, valuta og statusskifte, avviser manglende, ugyldige eller konfliktende data og sender avvik til en sporbar feilkø for korrigering og kontrollert nykjøring.",
      flags.designPhase
        ? "I designfasen validerer Atea bare konkrete feltbetegnelser mot denne forpliktede, foreslåtte kontrakten; objekter, ansvar, synkretning og feilbehandling endres ikke."
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return hasCompletePaymentApiContract(copy) &&
      deterministicDynamicControlCopyReflectsSource(
        entry,
        copy,
        new Set<DeterministicSourceQualifier>(["needsNote"]),
      )
      ? copy
      : null;
  }

  const isLmsContract =
    targets.length === 1 &&
    targets[0]?.comparable === normalizeComparableText("LMS");
  if (isLmsContract) {
    const copy = [
      `${offerLead} som foreslått integrasjonskontrakt et versjonert REST-API over HTTPS mot LMS med OAuth 2.0-klientlegitimasjon, separate scopes for LMS-lesing og LMS-skriving og operasjonene opprett og oppdater påmelding, hent kursgjennomføring og prøve, motta resultat og publiser sertifikatstatus.`,
      "Den foreslåtte datamodellen omfatter objektene kurs, kursgjennomføring, deltaker, prøve, resultat og sertifikat med nøkkelfeltene kurs-ID, gjennomførings-ID, deltaker-ID, prøve-ID og sertifikat-ID og feltmapping av påmeldingsstatus, poengsum, beståttstatus og gyldighetsperiode.",
      "LMS er autoritativt system for kursgjennomføring, prøve og resultat, mens skyplattformen er autoritativ for påmelding, deltakerkobling og sertifikatregister; skyplattformen synkroniserer påmeldinger til LMS, mottar gjennomføring og resultat tilbake, oppretter sertifikatet og publiserer sertifikatstatus og referanse til LMS.",
      "Integrasjonen validerer nøkkelfelt, referanser og statusskifte, avviser manglende, ugyldige eller konfliktende data og sender avvik til en sporbar feilkø for korrigering og kontrollert nykjøring.",
      flags.designPhase
        ? "I designfasen validerer Atea bare konkrete feltbetegnelser mot denne forpliktede, foreslåtte kontrakten; objekter, ansvar, synkretning og feilbehandling endres ikke."
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return hasCompleteLmsApiContract(copy) &&
      deterministicDynamicControlCopyReflectsSource(
        entry,
        copy,
        new Set<DeterministicSourceQualifier>(["needsNote"]),
      )
      ? copy
      : null;
  }

  const isIdentityCrmContract =
    targets.length === 2 &&
    targets[0]?.comparable === normalizeComparableText("ID-porten") &&
    targets[1]?.comparable === normalizeComparableText("CRM");
  if (isIdentityCrmContract) {
    const copy = [
      `${offerLead} som foreslått integrasjonskontrakt for ID-porten og CRM med separate mekanismer: ID-porten som føderert innlogging med OIDC Authorization Code og PKCE; skyplattformen validerer signatur, issuer, audience og ID-token-claimene sub, acr og amr før en identitetsbinding opprettes.`,
      "CRM-integrasjonen bruker et versjonert REST-API over HTTPS med OAuth 2.0-klientlegitimasjon, separate scopes for CRM-lesing og CRM-skriving og operasjonene opprett, hent og oppdater.",
      "Den foreslåtte datamodellen omfatter objektene ID-porten-identitet, CRM-kontakt og CRM-registrering med nøkkelfeltene externalSubject, CRM-post-ID og kurs-ID og feltmapping av issuer, sub, acr, amr, kontaktstatus, kurs-ID og synkroniseringsstatus; ID-porten er autoritativt system for innloggingsidentiteten, CRM er system of record for CRM-postene, og skyplattformen synkroniserer CRM-endringer i avtalt retning.",
      "Begge integrasjonene validerer nøkkelfelt, token eller skjema og avviser manglende, ugyldige eller konfliktende data til en sporbar feilkø uten å gi dem ordinær status.",
      flags.designPhase
        ? "I designfasen validerer Atea bare konkrete feltbetegnelser mot denne forpliktede kontrakten; protokoll, scopes, eierskap, synkretning og feilbehandling endres ikke."
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return hasCompleteIdentityCrmApiContract(copy) &&
      deterministicDynamicControlCopyReflectsSource(
        entry,
        copy,
        new Set<DeterministicSourceQualifier>(["needsNote"]),
      )
      ? copy
      : null;
  }

  const targetLabels = joinNorwegianList(targets.map((target) => target.label));
  const scopeLabels = targets.flatMap((target) => [
    `${target.key}-lesing`,
    `${target.key}-skriving`,
  ]);
  const dataElements = targets.flatMap((target) => [
    `${target.key}-referanse`,
    `${target.key}-status`,
  ]);
  const keyFields = targets.map((target) => `${target.key}-referanse-ID`);
  const ownership =
    targets.length === 1
      ? `${targets[0].label} er master for disse dataelementene i den foreslåtte integrasjonskontrakten`
      : `${targetLabels} er hvert sitt system of record for sine dataelementer i den foreslåtte integrasjonskontrakten`;
  const designSentence = flags.designPhase
    ? "I designfasen validerer Atea bare de konkrete feltbetegnelsene mot denne allerede forpliktede kontrakten; API-mønster, scopes, operasjoner, masteransvar, synkretning og feilbehandling endres ikke."
    : "";
  const copy = [
    `${offerLead} som foreslått integrasjonskontrakt et versjonert REST-API over HTTPS mellom skyplattformen og ${targetLabels}, med OAuth 2.0-klientlegitimasjon, separate scopes for ${joinNorwegianList(scopeLabels)} og operasjonene opprett, hent og oppdater.`,
    `Datamodellen omfatter dataelementene ${joinNorwegianList(dataElements)} med nøkkelfeltene ${joinNorwegianList(keyFields)} og feltmapping av ${joinNorwegianList(dataElements)}; ${ownership}, skyplattformen synkroniserer endringer fra ${targetLabels} til skyplattformen, og integrasjonene for ${targetLabels} avviser poster med manglende nøkkelfelt, ugyldige data eller versjonskonflikter og sender dem til en sporbar feilkø.`,
    designSentence,
  ]
    .filter(Boolean)
    .join(" ");
  return deterministicDynamicControlCopyReflectsSource(
    entry,
    copy,
    new Set<DeterministicSourceQualifier>(["needsNote"]),
  )
    ? copy
    : null;
}

function sourceBoundBackupDataScope(entry: RequirementLedgerEntry) {
  const match =
    /^Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av ([^.!?;:]+)\.?$/iu.exec(
      normalizePageText(entry.text),
    );
  const items = (match?.[1] ?? "")
    .split(/\s*,\s*|\s+(?:og|samt)\s+/iu)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 2 || items.length > 8) {
    return null;
  }
  if (
    items.some(
      (item) =>
        item.length > 48 ||
        !/^[\p{L}][\p{L}\p{N}-]*(?:\s+[\p{L}][\p{L}\p{N}-]*){0,2}$/u.test(
          item,
        ) ||
        /\b(?:skal|må|kan|ikke|uten|opsjon|avklar|pris|RTO|RPO|dag|time|uke|måned|år)\b/iu.test(
          item,
        ),
    )
  ) {
    return null;
  }
  return items;
}

function buildSourceBoundBackupControlCopy(entry: RequirementLedgerEntry) {
  const scope = sourceBoundBackupDataScope(entry);
  const flags = deterministicControlSourceFlags(entry);
  if (
    !scope ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicBackupSourceResidual(entry) !== "" ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    flags.clarification ||
    flags.assumption
  ) {
    return null;
  }
  const lead = flags.solutionProposal && flags.production
    ? "I løsningsforslaget for produksjonsløsningen"
    : flags.solutionProposal
      ? "I løsningsforslaget"
      : flags.production
        ? "For produksjonsløsningen"
        : flags.priority
          ? `For raden med prioritet «${flags.priority}»`
          : "Løsningen";
  const prioritySuffix =
    (flags.solutionProposal || flags.production) && flags.priority
      ? ` for raden med prioritet «${flags.priority}»`
      : "";
  const subject = flags.solutionProposal || flags.production || flags.priority
    ? " etablerer og drifter Atea"
    : " etablerer og drifter";
  const sourceBoundLead = flags.needsNote
    ? `For kravraden fra behovsarbeidet${
        flags.priority ? ` med prioritet «${flags.priority}»` : ""
      } etablerer og drifter Atea${
        flags.solutionProposal && flags.production
          ? " i løsningsforslaget for produksjonsløsningen"
          : flags.solutionProposal
            ? " i løsningsforslaget"
            : flags.production
              ? " for produksjonsløsningen"
              : ""
      }`
    : `${lead}${prioritySuffix}${subject}`;
  const copy = [
    `${sourceBoundLead} en dokumentert backup-rutine for produksjonsdata om ${joinNorwegianList(scope)}, med driftsansvarlig rolle, jobbkontroll og avviksvarsling; frekvens, oppbevaringstid, RTO, RPO og testkalender fastsettes per dataklasse i en backupmatrise som godkjennes før produksjonssetting og gjelder som bindende driftsparametere.`,
    "Kontrollert gjenoppretting følger dokumentert runbook; dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.",
    flags.designPhase
      ? "I designfasen validerer Atea bare matrisens dataklasser og dokumentform uten å utsette den forpliktede backup- og restoreprosessen."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return deterministicDynamicControlCopyReflectsSource(
    entry,
    copy,
    BACKUP_REFLECTED_SOURCE_QUALIFIERS,
  )
    ? copy
    : null;
}

function exactDeterministicControlRequirementPattern(
  entry: RequirementLedgerEntry,
): DeterministicControlRepairPattern | null {
  const requirement = normalizeRequirementLedgerText(entry.text);
  if (
    requirement ===
    normalizeRequirementLedgerText(EXACT_API_CALENDAR_IDENTITY_REQUIREMENT)
  ) {
    return "api_calendar_identity";
  }
  if (
    requirement ===
    normalizeRequirementLedgerText(EXACT_API_MEMBERSHIP_REGISTER_REQUIREMENT)
  ) {
    return "api_membership_register";
  }
  return requirement ===
    normalizeRequirementLedgerText(EXACT_AUTOMATIC_NOTIFICATION_ACCESS_REQUIREMENT)
    ? "automatic_notification_access"
    : null;
}

function isCanonicalNoManualSpreadsheetSupplierClarification(
  entry: RequirementLedgerEntry,
) {
  return /^Leverandøren må avklare og beskrive hvordan følgende løses:/iu.test(
    normalizePageText(entry.text),
  );
}

function parseCanonicalSinglePurposeLosslessQueueRetryRequirement(
  entry: RequirementLedgerEntry,
) {
  const requirement = normalizePageText(entry.text);
  const match = /^(?:(Leverandøren må avklare og beskrive hvordan følgende løses):\s*)?løsningen skal integreres med [^.!?;:]{1,180} og håndtere feil, kø og (?:ny\s+kjøring|nykjøring|gjenkjøring|retry) uten tap av [^.!?;:]{1,180}\.?$/iu.exec(
    requirement,
  );
  return match && isLosslessQueueRetryRequirement(requirement)
    ? { supplierClarification: Boolean(match[1]) }
    : null;
}

function buildSourceBoundLosslessQueueRetryControlCopy(
  entry: RequirementLedgerEntry,
) {
  const parsed = parseCanonicalSinglePurposeLosslessQueueRetryRequirement(entry);
  const flags = deterministicControlSourceFlags(entry);
  if (
    !parsed ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    (!parsed.supplierClarification && flags.clarification) ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }

  const lead = parsed.supplierClarification
    ? "Som leverandørens konkrete avklaring beskriver og tilbyr Atea"
    : "Atea leverer";
  return `${lead} integrasjonene i kravraden med outbox og idempotensnøkkel for tapsfri, duplikatsikker behandling. Feil går til en varig dead-letter-kø; køstatus, feilårsak og hver kontrollert retry eller nykjøring registreres i en sporbar hendelseslogg og avstemmes før godkjenning.`;
}

function buildSourceBoundIdentityCrmLosslessControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    !requirementExactlyMatches(entry.text, EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT) ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    flags.clarification ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }
  const priorityLead = flags.priority
    ? `For raden med prioritet «${flags.priority}» `
    : "";
  const copy = `${priorityLead}leverer Atea ID-porten som en synkron OIDC-innloggingsflyt: innloggingskall køes ikke eller replayes, og ved feil lagres ingen domeneendring for kurs, prøver, sertifikater eller deltakerprofiler før brukeren er autentisert; forsøket får korrelasjons-ID og sporbar feillogg. Opprettelse og oppdatering mot CRM legges derimot i en varig outbox med idempotensnøkkel, kontrollert retry og dead-letter-kø, og hver retry eller operatørstyrt nykjøring registreres i en sporbar hendelseslogg og fortsetter fra checkpoint. En avstemming kobler korrelasjons-ID og CRM-post til kurs, prøver, sertifikater og deltakerprofiler og verifiserer at hver godkjent endring finnes én gang før køposten lukkes.`;
  return hasCompleteIdentityCrmLosslessContract(copy) ? copy : null;
}

function buildSourceBoundLifecycleStatusControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    !requirementExactlyMatches(
      entry.text,
      EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
    ) ||
    (!deterministicControlRepairContextIsSafe(entry) &&
      !deterministicLifecycleClarificationContextIsSafe(entry)) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["clarification"]),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    !flags.clarification ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }
  const priorityLead = flags.priority
    ? ` for raden med prioritet «${flags.priority}»`
    : "";
  const copy = `Som leverandørens konkrete avklaring${priorityLead} leverer Atea følgende foreslåtte standardstatuser: kurs opprettet, publisert, pågår og avsluttet; prøver opprettet, åpen, levert og vurdert; sertifikater kladd, utstedt, utløpt eller trukket; deltakerprofiler opprettet, aktiv og inaktiv. Hver overgang valideres mot ansvarlig rolle og lagres med tidsstempel, forrige og ny status samt hendelseshistorikk fra opprettelse til avslutning. Standardmodellen inngår i leveransen, mens kundespesifikke overgangsregler håndteres som konfigurasjon uten å utsette statusfunksjonen.`;
  return hasCompleteLifecycleStatusContract(copy) ? copy : null;
}

function buildSourceBoundOfflineTenderWorkflowControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    !requirementExactlyMatches(entry.text, EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT) ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["clarification"]),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    !flags.clarification ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }
  const priorityLead = flags.priority
    ? ` for raden med prioritet «${flags.priority}»`
    : "";
  const copy = `Som leverandørens konkrete avklaring${priorityLead} leverer Atea offline-støtte for alle tre prosessene: brukeren kan opprette eller endre påmelding, registrere eksamensbesvarelse eller prøveresultat og lagre godkjent sertifikatgrunnlag eller åpne et tidligere utstedt sertifikatbevis uten nett; selve sertifikatutstedelsen fullføres etter kontrollert synkronisering. Endringer lagres i en kryptert lokal kø med idempotensnøkkel, brukeridentitet, enhets-ID og tidsstempel og synkroniseres i rekkefølge når forbindelsen er tilbake. Versjonskonflikter stoppes uten overskriving, vises til ansvarlig bruker og registreres sammen med nykjøring og resultat i en sporbar avvikslogg.`;
  return hasCompleteOfflineTenderWorkflow(copy) ? copy : null;
}

function buildSourceBoundLowLatencyOptionControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    !requirementExactlyMatches(entry.text, EXACT_LOW_LATENCY_TENDER_REQUIREMENT) ||
    !deterministicLowLatencyOptionContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["option"]),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    !flags.option ||
    flags.clarification ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }
  const priorityLead = flags.priority
    ? `For raden med prioritet «${flags.priority}» `
    : "";
  const copy = `${priorityLead}forplikter Atea lav ventetid i kritiske arbeidsprosesser som en separat priset opsjon for påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat. Ateas tilbudte responstidsmål er p95 under 2 sekunder ved en antatt lastprofil på 200 samtidige brukere; dette er Ateas leverandørforutsetning, ikke et kundekrav fra kilden, og verifiseres med lasttest og ytelsestest før produksjonssetting. I drift måler og overvåker Atea p95 per operasjon, varsler ved avvik og følger opp med kapasitetsjustering, skalering og dokumentert hendelseshåndtering.`;
  return hasCompleteLowLatencyTenderContract(copy) ? copy : null;
}

function buildSourceBoundLowLatencyTenderControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    !requirementExactlyMatches(entry.text, EXACT_LOW_LATENCY_TENDER_REQUIREMENT) ||
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["designPhase", "needsNote"]),
    ) !== "" ||
    flags.production ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    flags.clarification ||
    flags.assumption
  ) {
    return null;
  }
  const priority = flags.priority ? ` med prioritet «${flags.priority}»` : "";
  const lead = flags.needsNote
    ? `For kravraden fra behovsarbeidet${priority} forplikter Atea`
    : flags.priority
      ? `For raden${priority} forplikter Atea`
      : "Atea forplikter";
  const copy = [
    `${lead} lav ventetid i kritiske arbeidsprosesser for påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat med transaksjonsnære arbeidsflater, provisjonert kapasitet og eksplisitt reservekapasitet.`,
    `Ateas tilbudte responstidsmål er ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE} for de samme operasjonene; målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og verifiseres med lasttest og ytelsestest som bindende akseptansekriterium før produksjonssetting.`,
    "I drift måler og overvåker Atea p95 per operasjon, varsler ved avvik og følger opp med kapasitetsjustering, skalering og dokumentert hendelseshåndtering.",
    flags.designPhase
      ? "I designfasen validerer Atea bare endelig lastprofil mot det tilbudte målet; kjerneleveransen og målet utsettes ikke."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return hasCompleteLowLatencyTenderContract(copy) &&
    hasCompleteLowLatencyTenderSourceBinding(copy, entry) &&
    deterministicDynamicControlCopyReflectsSource(
      entry,
      copy,
      new Set<DeterministicSourceQualifier>(["needsNote"]),
    )
    ? copy
    : null;
}

function buildSourceBoundSeasonalScalabilityControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  if (
    entry.id !== "Avklaringskrav-06" ||
    normalizeRequirementLedgerText(entry.heading) !==
      normalizeRequirementLedgerText("Uavklarte, men viktige punkter") ||
    normalizeRequirementLedgerText(entry.tableId ?? "") !==
      normalizeRequirementLedgerText("Dokumenttekst") ||
    !isSeasonalScalabilityClarificationRequirement(entry.text) ||
    !deterministicSeasonalScalabilityContextIsSafe(entry) ||
    deterministicControlSourceResidual(
      entry,
      new Set<DeterministicSourceQualifier>(["clarification"]),
    ) !== "" ||
    flags.priority === "Bør" ||
    flags.priority === "Kan" ||
    flags.production ||
    flags.designPhase ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    !flags.clarification ||
    flags.assumption ||
    flags.needsNote
  ) {
    return null;
  }
  const copy = [
    "Som leverandørens konkrete avklaring forplikter Atea skalerbarhet ved sesongtopper for havneterminal og lasteoperasjoner gjennom en kapasitetsmodell med autoskalering og reservekapasitet, verifisert med lasttest og ytelsestest, for operasjonene logge inn, åpne arbeidsliste og lagre endring.",
    `Ateas tilbudte responstidsmål er ${STANDARD_SUPPLIER_PERFORMANCE_BASELINE} for de samme operasjonene; målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og er bindende akseptansekriterium før produksjonssetting.`,
    "Atea måler baselinen og kapasitetsmarginen per operasjon og dokumenterer testresultat og avvik før produksjonssetting.",
  ].join(" ");
  return deterministicDynamicControlCopyReflectsSource(
    entry,
    copy,
    new Set<DeterministicSourceQualifier>(["clarification"]),
  )
    ? copy
    : null;
}

function hasExactProject002NoManualSpreadsheetUsers(
  userGroups: string[],
) {
  return (
    userGroups.map(normalizeComparableText).join("\u001f") ===
    ["terminaloperatører", "transportører", "havnevakt"]
      .map(normalizeComparableText)
      .join("\u001f")
  );
}

const EXACT_PROJECT_008_REQUIREMENT_DOCUMENT =
  "008_Bilag_2_Krav_NordTak_Prosjekt_AS";

function isExactProject008RequirementDocument(
  entry: RequirementLedgerEntry,
) {
  return (
    normalizeRequirementLedgerText(entry.documentTitle ?? "") ===
    normalizeRequirementLedgerText(EXACT_PROJECT_008_REQUIREMENT_DOCUMENT)
  );
}

function hasExactProject008NoManualSpreadsheetUsers(
  userGroups: string[],
) {
  return (
    userGroups.map(normalizeComparableText).join("\u001f") ===
    ["prosjektledere", "montører", "innkjøpere", "kunder"]
      .map(normalizeComparableText)
      .join("\u001f")
  );
}

function isExactProject008NeedsNoteSpreadsheetRow(
  entry: RequirementLedgerEntry,
  userGroups: string[],
) {
  return (
    isExactProject008RequirementDocument(entry) &&
    entry.id === "Notatkrav-11" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Tekstutdrag fra bestiller") &&
    normalizeRequirementLedgerText(entry.tableId ?? "") ===
      normalizeRequirementLedgerText("Dokumenttekst") &&
    hasExactProject008NoManualSpreadsheetUsers(userGroups)
  );
}

function isExactProject008ClarifiedSpreadsheetRow(
  entry: RequirementLedgerEntry,
  userGroups: string[],
) {
  return (
    isExactProject008RequirementDocument(entry) &&
    entry.id === "KR-059" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Uavklarte, men viktige punkter") &&
    !normalizeRequirementLedgerText(entry.tableId ?? "") &&
    isCanonicalNoManualSpreadsheetSupplierClarification(entry) &&
    hasExactProject008NoManualSpreadsheetUsers(userGroups)
  );
}

function isExactProject002NeedsNoteSpreadsheetRow(
  entry: RequirementLedgerEntry,
  userGroups: string[],
) {
  return (
    entry.id === "Notatkrav-01" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Løse krav fra behovsmøte") &&
    normalizeRequirementLedgerText(entry.tableId ?? "") ===
      normalizeRequirementLedgerText("Dokumenttekst") &&
    hasExactProject002NoManualSpreadsheetUsers(userGroups)
  );
}

function isExactProject002QualifiedSpreadsheetRow(
  entry: RequirementLedgerEntry,
  userGroups: string[],
) {
  return (
    entry.id === "Støttedokument - tabell 3, rad 2" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Ting som ikke må glemmes") &&
    normalizeRequirementLedgerText(entry.tableId ?? "") ===
      normalizeRequirementLedgerText("DOCX tabell 3") &&
    hasExactProject002NoManualSpreadsheetUsers(userGroups)
  );
}

function isExactProject002ClarifiedSpreadsheetRow(
  entry: RequirementLedgerEntry,
  userGroups: string[],
) {
  return (
    entry.id === "K023" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Uavklarte, men viktige punkter") &&
    !normalizeRequirementLedgerText(entry.tableId ?? "") &&
    isCanonicalNoManualSpreadsheetSupplierClarification(entry) &&
    hasExactProject002NoManualSpreadsheetUsers(userGroups)
  );
}

function buildSourceBoundNoManualSpreadsheetControlCopy(
  entry: RequirementLedgerEntry,
) {
  const flags = deterministicControlSourceFlags(entry);
  const userGroups = canonicalNoManualSpreadsheetUserGroups(entry);
  if (userGroups === null) {
    return null;
  }
  const isNeedsNoteRow =
    isExactProject002NeedsNoteSpreadsheetRow(entry, userGroups) ||
    isExactProject008NeedsNoteSpreadsheetRow(entry, userGroups);
  const isQualifiedRow = isExactProject002QualifiedSpreadsheetRow(
    entry,
    userGroups,
  );
  const isClarifiedRow =
    isExactProject002ClarifiedSpreadsheetRow(entry, userGroups) ||
    isExactProject008ClarifiedSpreadsheetRow(entry, userGroups);
  const allowedQualifiers = new Set<DeterministicSourceQualifier>([
    "designPhase",
    ...(isNeedsNoteRow ? (["needsNote"] as const) : []),
    ...(isQualifiedRow ? (["production"] as const) : []),
    ...(isClarifiedRow ? (["clarification"] as const) : []),
  ]);
  if (
    !deterministicControlRepairContextIsSafe(entry) ||
    deterministicControlSourceResidual(entry, allowedQualifiers) !== "" ||
    (flags.production && !isQualifiedRow) ||
    flags.solutionProposal ||
    flags.documentation ||
    flags.supplierResponse ||
    flags.option ||
    (flags.clarification && !isClarifiedRow) ||
    flags.assumption ||
    (flags.needsNote && !isNeedsNoteRow) ||
    (isNeedsNoteRow && !flags.needsNote) ||
    (isQualifiedRow &&
      (!flags.production || flags.priority !== "Kan")) ||
    (isClarifiedRow && !flags.clarification)
  ) {
    return null;
  }
  const users = userGroups.length
    ? joinNorwegianList(userGroups)
    : "brukere";
  const qualifierLead = isClarifiedRow
    ? "Som leverandørens konkrete avklaring beskriver og tilbyr Atea"
    : isNeedsNoteRow
      ? "For kravraden fra behovsarbeidet tilbyr Atea"
      : isQualifiedRow
        ? "For produksjonsløsningen og raden med prioritet «Kan» tilbyr Atea"
        : flags.priority
          ? `For raden med prioritet «${flags.priority}» tilbyr Atea`
          : "Atea tilbyr";
  const workflowSentence = `${qualifierLead} en arbeidsflyt der ${users} utfører oppgaver, registrering og oppfølging direkte i løsningen.`;
  const copy = [
    workflowSentence,
    "Oppgaver opprettes og oppdateres i det felles datagrunnlaget, data registreres én gang og deles mellom brukergruppenes arbeidsflyter; manuelle regneark brukes ikke.",
    flags.designPhase
      ? "I designfasen validerer Atea bare skjermrekkefølge og feltoppsett uten å utsette den forpliktede kjernearbeidsflyten."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return deterministicDynamicControlCopyReflectsSource(
    entry,
    copy,
    new Set<DeterministicSourceQualifier>([
      ...(isNeedsNoteRow ? (["needsNote"] as const) : []),
      ...(isClarifiedRow ? (["clarification"] as const) : []),
    ]),
  )
    ? copy
    : null;
}

function isCanonicalSinglePurposeStructuredExportRequirement(
  entry: RequirementLedgerEntry,
) {
  const requirement = normalizeRequirementLedgerText(entry.text);
  const tokens = requirement.match(/[\p{L}\p{N}]+/gu) ?? [];
  const mandatorySignals = tokens.filter((token) =>
    ["skal", "må", "shall", "must"].includes(token),
  );
  const hasSingleExportSentence = splitIntoSentences(requirement).length === 1;
  const hasExplicitExportAction =
    /\b(?:hent(?:e|es)\s+ut|eksport(?:ere|eres)?)\b/iu.test(requirement);
  const hasOnlyExpectedTerminalPurpose =
    /\bved\s+(?:revisjon(?:\s+eller\s+leverandør(?:bytte|skifte))?|leverandør(?:bytte|skifte)(?:\s+eller\s+revisjon)?)\.?$/iu.test(
      requirement,
    );
  const hasUnsafeQualifier =
    /\b(?:ikke|ingen|aldri|valgfri\w*|opsjon\w*|tilvalg|vedlegg|bilag|annex|appendix|avklar\w*|senere|prises?\s+separat)\b/iu.test(
      requirement,
    ) || /\d/u.test(requirement);
  const hasUnrelatedCoreAction =
    /\b(?:slett|integrer|migrer|varsl|logg|krypter|autentiser|gjenopprett|backup)\w*\b/iu.test(
      requirement,
    );

  return (
    isStructuredExportPortabilityRequirement(requirement) &&
    mandatorySignals.length === 1 &&
    hasSingleExportSentence &&
    hasExplicitExportAction &&
    hasOnlyExpectedTerminalPurpose &&
    !hasUnsafeQualifier &&
    !hasUnrelatedCoreAction
  );
}

function highConfidenceCoverageRequirementPattern(
  entry: RequirementLedgerEntry,
): HighConfidenceCoveragePattern | null {
  const requirement = normalizeRequirementLedgerText(entry.text);
  if (isTimedReminderControlRequirement(requirement)) {
    return "timed_reminder";
  }
  if (isHistoricalMigrationValidationRequirement(requirement)) {
    return "historical_migration";
  }
  if (isAuditChangeLogRequirement(requirement)) {
    return "audit_change_log";
  }
  if (isBackupRestoreVerificationRequirement(requirement)) {
    return "backup_restore";
  }
  if (isAcceptanceTestCoverageRequirement(requirement)) {
    return "acceptance_test";
  }
  return null;
}

function deterministicControlRepairRequirementPattern(
  entry: RequirementLedgerEntry,
): DeterministicControlRepairPattern | null {
  if (isCanonicalSinglePurposeProfiledDimensioningRequirement(entry)) {
    return "dimensioning_supplier_baseline";
  }
  if (
    entry.id === "Avklaringskrav-06" &&
    normalizeRequirementLedgerText(entry.heading) ===
      normalizeRequirementLedgerText("Uavklarte, men viktige punkter") &&
    normalizeRequirementLedgerText(entry.tableId ?? "") ===
      normalizeRequirementLedgerText("Dokumenttekst") &&
    isSeasonalScalabilityClarificationRequirement(entry.text)
  ) {
    return "seasonal_scalability";
  }
  const exactPattern = exactDeterministicControlRequirementPattern(entry);
  if (exactPattern) {
    return exactPattern;
  }
  const highConfidencePattern =
    highConfidenceCoverageRequirementPattern(entry);
  if (highConfidencePattern) {
    return highConfidencePattern;
  }
  if (sourceBoundApiTargets(entry)) {
    return "api_source_bound";
  }
  if (
    requirementExactlyMatches(entry.text, EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT)
  ) {
    return "lossless_identity_crm_retry";
  }
  if (
    requirementExactlyMatches(
      entry.text,
      EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
    )
  ) {
    return "lifecycle_status_contract";
  }
  if (requirementExactlyMatches(entry.text, EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT)) {
    return "offline_tender_workflow";
  }
  if (requirementExactlyMatches(entry.text, EXACT_LOW_LATENCY_TENDER_REQUIREMENT)) {
    return deterministicControlSourceFlags(entry).option
      ? "low_latency_supplier_option"
      : "low_latency_tender_contract";
  }
  const requirement = normalizeRequirementLedgerText(entry.text);
  if (parseCanonicalSinglePurposeLosslessQueueRetryRequirement(entry)) {
    return "lossless_queue_retry";
  }
  if (isNoManualSpreadsheetRequirement(requirement)) {
    return "no_manual_spreadsheet";
  }
  return isStructuredExportPortabilityRequirement(requirement)
    ? "structured_export"
    : null;
}

function isHighConfidenceDeterministicControlPattern(
  pattern: DeterministicControlRepairPattern,
): pattern is HighConfidenceCoveragePattern {
  return [
    "timed_reminder",
    "historical_migration",
    "audit_change_log",
    "backup_restore",
    "acceptance_test",
  ].includes(pattern);
}

function deterministicControlRepairCopy(
  pattern: DeterministicControlRepairPattern,
  entry: RequirementLedgerEntry,
) {
  if (pattern === "timed_reminder") {
    return (
      buildSourceBoundTimedReminderControlCopy(entry) ??
      DETERMINISTIC_CONTROL_REPAIR_COPY[pattern] ??
      null
    );
  }
  if (pattern === "api_source_bound") {
    return buildSourceBoundApiControlCopy(entry);
  }
  if (pattern === "backup_restore") {
    return buildSourceBoundBackupControlCopy(entry);
  }
  if (pattern === "no_manual_spreadsheet") {
    return buildSourceBoundNoManualSpreadsheetControlCopy(entry);
  }
  if (pattern === "lossless_queue_retry") {
    return buildSourceBoundLosslessQueueRetryControlCopy(entry);
  }
  if (pattern === "lossless_identity_crm_retry") {
    return buildSourceBoundIdentityCrmLosslessControlCopy(entry);
  }
  if (pattern === "lifecycle_status_contract") {
    return buildSourceBoundLifecycleStatusControlCopy(entry);
  }
  if (pattern === "offline_tender_workflow") {
    return buildSourceBoundOfflineTenderWorkflowControlCopy(entry);
  }
  if (pattern === "low_latency_supplier_option") {
    return buildSourceBoundLowLatencyOptionControlCopy(entry);
  }
  if (pattern === "low_latency_tender_contract") {
    return buildSourceBoundLowLatencyTenderControlCopy(entry);
  }
  if (pattern === "seasonal_scalability") {
    return buildSourceBoundSeasonalScalabilityControlCopy(entry);
  }
  return DETERMINISTIC_CONTROL_REPAIR_COPY[pattern] ?? null;
}

/**
 * Last-resort repair for exact, single-purpose control requirements.
 * Eligibility is deliberately narrow. Canonical requirement text rejects
 * compound rows, while dynamic repairs allowlist only source qualifiers that
 * their generated copy reflects. Every other source residual fails closed so
 * documented scope and operating parameters cannot be overwritten.
 */
export function buildDeterministicFinalRequirementControlRepair(input: {
  entry: RequirementLedgerEntry;
  evidence?: string;
}): RequirementAnswerResult | null {
  const pattern = deterministicControlRepairRequirementPattern(input.entry);
  if (
    !deterministicControlRepairContextIsSafe(input.entry) &&
    !(
      pattern === "low_latency_supplier_option" &&
      deterministicLowLatencyOptionContextIsSafe(input.entry)
    ) &&
    !(
      pattern === "lifecycle_status_contract" &&
      deterministicLifecycleClarificationContextIsSafe(input.entry)
    ) &&
    !(
      pattern === "seasonal_scalability" &&
      deterministicSeasonalScalabilityContextIsSafe(input.entry)
    )
  ) {
    return null;
  }
  if (pattern === "dimensioning_supplier_baseline") {
    const validatedTemplate = buildDeterministicFinalRequirementTemplateRepair(input);
    return validatedTemplate
      ? {
          ...validatedTemplate,
          source: "deterministic_control_repair",
        }
      : null;
  }
  const exactPattern = exactDeterministicControlRequirementPattern(input.entry);
  const eligible = pattern
    ? exactPattern
      ? pattern === exactPattern &&
        deterministicStaticControlSourceIsSafe(input.entry)
      : pattern === "api_source_bound"
        ? buildSourceBoundApiControlCopy(input.entry) !== null
      : pattern === "no_manual_spreadsheet"
        ? buildSourceBoundNoManualSpreadsheetControlCopy(input.entry) !== null
      : pattern === "lossless_queue_retry"
        ? buildSourceBoundLosslessQueueRetryControlCopy(input.entry) !== null
      : pattern === "lossless_identity_crm_retry"
        ? buildSourceBoundIdentityCrmLosslessControlCopy(input.entry) !== null
      : pattern === "lifecycle_status_contract"
        ? buildSourceBoundLifecycleStatusControlCopy(input.entry) !== null
      : pattern === "offline_tender_workflow"
        ? buildSourceBoundOfflineTenderWorkflowControlCopy(input.entry) !== null
      : pattern === "low_latency_supplier_option"
        ? buildSourceBoundLowLatencyOptionControlCopy(input.entry) !== null
      : pattern === "low_latency_tender_contract"
        ? buildSourceBoundLowLatencyTenderControlCopy(input.entry) !== null
      : pattern === "seasonal_scalability"
        ? buildSourceBoundSeasonalScalabilityControlCopy(input.entry) !== null
      : pattern === "structured_export"
          ? isCanonicalSinglePurposeStructuredExportRequirement(input.entry) &&
            deterministicStaticControlSourceIsSafe(input.entry)
        : pattern === "timed_reminder" &&
            buildSourceBoundTimedReminderControlCopy(input.entry) !== null
          ? true
          : isHighConfidenceDeterministicControlPattern(pattern) &&
            isCanonicalSinglePurposeHighConfidenceRequirement(
              pattern,
              input.entry,
            ) &&
            (pattern === "backup_restore"
              ? buildSourceBoundBackupControlCopy(input.entry) !== null
              : deterministicStaticControlSourceIsSafe(input.entry))
    : false;
  if (!pattern || !eligible) {
    return null;
  }

  const repairCopy = deterministicControlRepairCopy(pattern, input.entry);
  if (!repairCopy) {
    return null;
  }
  const normalized = normalizeRequirementAnswerResult(
    repairCopy,
    input.entry,
    input.evidence,
  );
  const passesQualityGate =
    requirementAnswerQualityIssues(normalized.answer, input.entry).length === 0;
  const passesPatternVerification =
    passesQualityGate &&
    (!isHighConfidenceDeterministicControlPattern(pattern) ||
      completeHighConfidenceCoveragePattern(input.entry, normalized.answer) ===
        pattern);
  if (normalized.source === "deterministic_fallback" || !passesPatternVerification) {
    return null;
  }

  return {
    ...normalized,
    source: "deterministic_control_repair",
  };
}

export function buildDeterministicControlRepairMetadata(input: {
  answers: RequirementAnswerResult[];
  ledger: RequirementLedgerEntry[];
  repairStageByIndex?: ReadonlyMap<number, DeterministicControlRepairStage>;
}) {
  const rows = input.answers.flatMap((answer, index) => {
    const entry = input.ledger[index];
    if (answer.source !== "deterministic_control_repair" || !entry) {
      return [];
    }
    const pattern = deterministicControlRepairRequirementPattern(entry);
    const repairStage = input.repairStageByIndex?.get(index);
    return pattern
      ? [
          {
            ref: requirementDisplayRef(entry, requirementGroupHeading(entry)),
            pattern,
            order_index: index,
            source_document_id: entry.documentId ?? null,
            source_locator: requirementDisplaySource(
              entry,
              requirementGroupHeading(entry),
            ),
            ...(repairStage ? { repair_stage: repairStage } : {}),
          },
        ]
      : [];
  });
  const manualReviewRequired = rows.length > 0;

  return {
    deterministic_control_repair_answers: rows.length,
    ...(input.repairStageByIndex
      ? {
          deterministic_control_repair_answers_before_handoff: rows.filter(
            (row) => row.repair_stage === "pre_handoff",
          ).length,
          deterministic_control_repair_answers_during_handoff: rows.filter(
            (row) => row.repair_stage === "handoff",
          ).length,
        }
      : {}),
    deterministic_control_repair_refs: rows.map((row) => row.ref),
    deterministic_control_repair_rows: rows,
    manual_review_required: manualReviewRequired,
    ...(manualReviewRequired
      ? {
          manual_review_note:
            DETERMINISTIC_CONTROL_REPAIR_MANUAL_REVIEW_NOTE,
        }
      : {}),
  };
}

function completeHighConfidenceCoveragePattern(
  entry: RequirementLedgerEntry,
  answer: string,
): HighConfidenceCoveragePattern | null {
  const requirement = normalizeRequirementLedgerText(entry.text);
  if (
    isTimedReminderControlRequirement(requirement) &&
    hasCompleteTimedReminderControl(answer, requirement)
  ) {
    return "timed_reminder";
  }
  if (
    isHistoricalMigrationValidationRequirement(requirement) &&
    hasCompleteHistoricalMigrationValidation(answer)
  ) {
    return "historical_migration";
  }
  if (
    isAuditChangeLogRequirement(requirement) &&
    hasCompleteAuditChangeLog(answer)
  ) {
    return "audit_change_log";
  }
  if (
    isBackupRestoreVerificationRequirement(requirement) &&
    hasCompleteBackupRestoreVerification(answer)
  ) {
    return "backup_restore";
  }
  if (
    isAcceptanceTestCoverageRequirement(requirement) &&
    hasCompleteAcceptanceTestCoverage(answer)
  ) {
    return "acceptance_test";
  }
  return null;
}

const HIGH_CONFIDENCE_REQUIREMENT_VOCABULARY: Record<
  HighConfidenceCoveragePattern,
  RegExp
> = {
  timed_reminder:
    /^(?:løsning(?:en)?|leverandør(?:en)?|system(?:et)?|skal|må|støtt\w*|lever\w*|tilby\w*|ha|tidsstyr\w*|påminn\w*|for|å|gjennomfør\w*|koordiner\w*|frivillig\w*|oppdrag\w*|samtykk\w*|varsl\w*|melding\w*|aktivitet\w*|på|en|kontroller\w*|sporbar\w*|måte|knytt\w*|til|av|og)$/iu,
  historical_migration:
    /^(?:historisk\w*|oppdrag\w*|frivillig\w*|samtykk\w*|melding\w*|skal|må|kan|kunne|migrer\w*|overfør\w*|til|løsning(?:en)?|leverandør(?:en)?|med|feltmapping|datamapping|valider\w*|validering|og|avviksrapport\w*|før|produksjonssetting)$/iu,
  audit_change_log:
    /^(?:alle|hver|endring\w*|i|oppdrag\w*|frivillig\w*|samtykk\w*|melding\w*|skal|må|logg\w*|med|bruker\w*|tjenesteidentitet|tidspunkt|gammel|ny|verdi|og|auditlogg\w*)$/iu,
  backup_restore:
    /^(?:det|skal|må|finnes|etableres|dokumenteres|rutine\w*|runbook\w*|for|backup|sikkerhetskopi\w*|gjenoppretting|restore|og|verifikasjon|av|oppdrag\w*|frivillig\w*|samtykk\w*|melding\w*|løsning(?:en)?|leverandør(?:en)?)$/iu,
  acceptance_test:
    /^(?:akseptansetest\w*|skal|må|dekke\w*|omfatte\w*|minst|brukerroller|integrasjoner|rapporter|feilscenarier|tilgangsendringer|og)$/iu,
};

function isCanonicalSinglePurposeHighConfidenceRequirement(
  pattern: HighConfidenceCoveragePattern,
  entry: RequirementLedgerEntry,
) {
  const vocabulary = HIGH_CONFIDENCE_REQUIREMENT_VOCABULARY[pattern];
  const normalized = normalizeRequirementLedgerText(entry.text);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const mandatorySignals = tokens.filter((token) =>
    ["skal", "må", "shall", "must"].includes(token),
  );
  if (pattern === "backup_restore") {
    return (
      mandatorySignals.length === 1 &&
      sourceBoundBackupDataScope(entry) !== null
    );
  }
  return (
    mandatorySignals.length === 1 &&
    tokens.length > 0 &&
    tokens.every((token) => vocabulary.test(token))
  );
}

export function correctCoverageAssessmentWithSourceEvidence(input: {
  entry: RequirementLedgerEntry;
  assessment: RequirementCoverageItem["assessment"];
  rationale: string;
  evidence: string;
  recommendation: string;
}): {
  assessment: RequirementCoverageItem["assessment"];
  rationale: string;
  evidence: string;
  recommendation: string;
} {
  const answerEvidence = substantiveRequirementAnswerExcerpt(input.entry);
  const hasAuthoritativeRequirementWithoutAnswer =
    input.entry.sourceExcerpt?.startsWith("Kravgrunnlag:") &&
    !input.entry.sourceExcerpt.includes("Svarrad:");
  if (!answerEvidence && hasAuthoritativeRequirementWithoutAnswer) {
    return {
      assessment: "Mangler",
      rationale:
        "Original kravledger inneholder kravet, men det finnes ingen matchet svarrad eller svarutdrag for kravet i løsningsdokumentet.",
      evidence: compactText(input.entry.sourceExcerpt ?? input.entry.text, 420),
      recommendation:
        "Legg inn en egen kravrad med konkret svar, ansvar, kontroll og dokumentasjon for dette kravet.",
    };
  }

  if (!answerEvidence) {
    return {
      assessment: input.assessment,
      rationale: input.rationale,
      evidence: input.evidence,
      recommendation: input.recommendation,
    };
  }

  const hasAttachmentReference = answerReferencesExternalAttachment(answerEvidence);
  const hasAttachmentBackedAnswer =
    answerIsAttachmentBackedRequirementAnswer(answerEvidence);
  const explicitlyDeclinesRequirement =
    answerExplicitlyDeclinesRequirement(answerEvidence, input.entry.text);
  const defersRequirementConfirmation =
    answerDefersRequirementConfirmation(answerEvidence);
  const mandatoryRequirement = isMandatoryRequirementEntry(input.entry);
  const hasSelfContainedCoverage = answerHasSelfContainedCoverage(
    answerEvidence,
    input.entry,
  );
  const attachmentCarriesNecessaryCoverage =
    hasAttachmentBackedAnswer && !hasSelfContainedCoverage;

  if (mandatoryRequirement && explicitlyDeclinesRequirement) {
    return {
      assessment: "Dårlig",
      rationale:
        "Svarutdraget avslår eller plasserer et obligatorisk krav utenfor leveransen. Det er et faktisk svar, men det oppfyller ikke kravet og kan derfor verken vurderes som Godt, Uklart eller Mangler.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Bevar avslaget som et dokumentert avvik inntil leverandøren har besluttet og bekreftet en endret leveranse, inkludert omfang og pris. Beskriv deretter løsning, ansvar, kontroll og verifikasjon, eller behold avviket for tilbudsbeslutning.",
    };
  }

  if (
    hasAttachmentReference &&
    !explicitlyDeclinesRequirement &&
    defersRequirementConfirmation
  ) {
    return {
      assessment: "Uklart",
      rationale:
        "Svarutdraget viser til vedlagt dokumentasjon, men bekrefter samtidig at omfang, ansvar eller løsning må avklares. Dekningen er derfor ikke verifiserbar nok til å være Godt.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Avklar omfang, ansvar og løsningsvalg, og behold vedleggsreferansen som dokumentasjon når leveransen er bekreftet.",
    };
  }

  if (
    attachmentCarriesNecessaryCoverage &&
    !explicitlyDeclinesRequirement &&
    !defersRequirementConfirmation
  ) {
    return {
      assessment: "Uklart",
      rationale:
        "Svarutdraget viser til et vedlegg eller bilag som ikke er verifisert i vurderingskonteksten. Kravdekningen kan derfor ikke klassifiseres som Godt før det refererte beviset er kontrollert.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Kontroller at det navngitte vedlegget finnes og faktisk dokumenterer kravet, og løft de viktigste bevisene inn i hovedsvaret.",
    };
  }

  if (answerEvidence.length < 24 || /^(?:ja|nei|yes|no)[.!]?$/i.test(answerEvidence)) {
    return {
      assessment: "Dårlig",
      rationale:
        "Svarutdraget er for kort eller binært til å dokumentere hvordan kravet faktisk oppfylles.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Erstatt det korte svaret med konkret leveransebeskrivelse, ansvar, kontroll og dokumentasjon for kravet.",
    };
  }

  if (answerIsVagueGenericRequirementAnswer(answerEvidence)) {
    return {
      assessment: "Dårlig",
      rationale:
        "Svarutdraget bruker generiske formuleringer om beste praksis, behovstilpasning eller senere avklaring uten å beskrive en testbar leveranse, ansvar, kontroll eller dokumentasjon.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Erstatt det generiske svaret med kravspesifikk leveransebeskrivelse, ansvarlig eier, kontrollpunkt, dokumentasjon og eventuelle konkrete forbehold.",
    };
  }

  if (
    defersRequirementConfirmation &&
    !explicitlyDeclinesRequirement
  ) {
    return {
      assessment: "Uklart",
      rationale:
        "Svarutdraget sier at leveranse, omfang eller ansvar må avklares før kravet kan bekreftes. Det er et faktisk svar, men dekningen er ikke verifiserbar nok til å være Godt eller tydelig nok til å være et endelig avslag.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Avklar omfang, ansvar, løsningsvalg og eventuell pris med leverandøren. Bevar forbeholdet inntil leveransen er bekreftet; beskriv en mulig endring som et forslag, ikke som en inngått forpliktelse.",
    };
  }

  const answerLooksLikeRequirementRestatement =
    isNearDuplicate(answerEvidence, input.entry.text, 0.9) &&
    answerEvidence.length <= input.entry.text.length * 1.45;
  if (answerLooksLikeRequirementRestatement) {
    return {
      assessment: "Dårlig",
      rationale:
        "Svarutdraget gjentar i praksis kravteksten uten å beskrive faktisk leveranse, ansvar, kontroll eller verifikasjon.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Erstatt kravgjentakelsen med et konkret svar som beskriver hvordan kravet oppfylles, hvordan det testes og hvem som eier oppfølgingen.",
    };
  }

  const claimsMissingAttachmentBackedDetail =
    coverageTextClaimsMissingAttachmentBackedDetail(input.rationale) ||
    coverageTextClaimsMissingAttachmentBackedDetail(input.evidence) ||
    coverageTextClaimsMissingAttachmentBackedDetail(input.recommendation);
  if (hasAttachmentReference && claimsMissingAttachmentBackedDetail) {
    return {
      assessment: input.assessment === "Mangler" ? "Uklart" : input.assessment,
      rationale:
        "Svarutdraget viser til vedlegg for dette punktet. Vurderingen skal derfor ikke konkludere med at informasjonen mangler i Bilag 2 uten å kontrollere vedlegget; vurder heller hvor tydelig vedleggsreferansen er for evaluator.",
      evidence: compactText(answerEvidence, 420),
      recommendation:
        "Behold vedleggsreferansen, og trekk inn den konkrete opplysningen fra vedlegget i hovedsvaret hvis evaluator forventer at den står direkte i kravraden.",
    };
  }

  if (input.assessment !== "Mangler") {
    const answerBoundEvidence = coverageEvidenceMatchesEntry({
      entry: input.entry,
      evidence: input.evidence,
      answerBoundOnly: true,
    })
      ? input.evidence
      : compactText(
          input.entry.answerEvidenceExcerpt || answerEvidence,
          420,
        );
    return {
      assessment: input.assessment,
      rationale: input.rationale,
      evidence: answerBoundEvidence,
      recommendation: input.recommendation,
    };
  }

  return {
    assessment: answerEvidence.length >= 80 ? "Dårlig" : "Uklart",
    rationale:
      input.rationale ||
      "Kildeutdraget inneholder et faktisk svar på kravraden. Kravet kan derfor ikke klassifiseres som Mangler uten manuell verifikasjon; vurderingen må heller handle om kvalitet, presisjon og kundetilpasning.",
    evidence: input.evidence || compactText(answerEvidence, 420),
    recommendation:
      input.recommendation ||
      "Vurder svaret opp mot kravet og styrk det med konkret leveranse, ansvar, kontroll, dokumentasjon og eventuelle forbehold.",
  };
}

export function normalizedCoverageRef(value: string) {
  return normalizeRequirementId(value).replace(/\s+/g, "");
}

function coverageRowAssessment(value: unknown) {
  return value === "Godt" ||
    value === "Dårlig" ||
    value === "Mangler" ||
    value === "Uklart"
    ? value
    : "";
}

export function validateRequirementCoverageBatchRows(input: {
  rows: RequirementCoverageBatchAnswer[];
  entries: RequirementLedgerEntry[];
  startIndex: number;
}) {
  const issues: string[] = [];
  if (input.rows.length !== input.entries.length) {
    issues.push(
      `forventet ${input.entries.length} rader, mottok ${input.rows.length}`,
    );
  }

  const expectedNumbers = input.entries.map(
    (_, index) => input.startIndex + index + 1,
  );
  const expectedNumberSet = new Set(expectedNumbers);
  const rowsByNumber = new Map<number, RequirementCoverageBatchAnswer>();
  const duplicateNumbers = new Set<number>();

  input.rows.forEach((row, index) => {
    if (
      typeof row.nr !== "number" ||
      !Number.isFinite(row.nr) ||
      !Number.isInteger(row.nr)
    ) {
      issues.push(`rad ${index + 1} mangler et eksakt heltalls-nr`);
      return;
    }
    if (!expectedNumberSet.has(row.nr)) {
      issues.push(`uventet nr=${row.nr}`);
    }
    if (rowsByNumber.has(row.nr)) {
      duplicateNumbers.add(row.nr);
      return;
    }
    rowsByNumber.set(row.nr, row);
  });

  if (duplicateNumbers.size) {
    issues.push(
      `dupliserte nr=${Array.from(duplicateNumbers)
        .sort((left, right) => left - right)
        .join(",")}`,
    );
  }

  expectedNumbers.forEach((expectedNr, index) => {
    const row = rowsByNumber.get(expectedNr);
    if (!row) {
      issues.push(`mangler nr=${expectedNr}`);
      return;
    }

    const expectedRef = requirementCoverageIdentityRef(input.entries[index]);
    const actualRef = row.ref?.replace(/\s+/g, " ").trim() ?? "";
    if (!actualRef) {
      issues.push(`nr=${expectedNr} mangler ref`);
    } else if (
      normalizedCoverageRef(actualRef) !== normalizedCoverageRef(expectedRef)
    ) {
      issues.push(
        `nr=${expectedNr} har ref="${compactText(actualRef, 100)}", forventet "${compactText(expectedRef, 100)}"`,
      );
    }

    if (!coverageRowAssessment(row.assessment ?? row.vurdering)) {
      issues.push(`nr=${expectedNr} mangler gyldig assessment`);
    }
  });

  if (issues.length) {
    throw new Error(`Ugyldig coverage-batch: ${issues.join("; ")}.`);
  }

  return expectedNumbers.map((expectedNr) => rowsByNumber.get(expectedNr)!);
}

/**
 * Flattens text for quote matching while keeping a one-to-one character
 * mapping between the flat text and its lower-cased form, so a match can be
 * mapped back to the original wording.
 */
function flattenQuoteText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00ad/gu, "")
    .replace(/\[\[SIDE:\d{1,5}(?:-\d{1,5})?\]\]/gu, " ")
    // Docling writes headings as Markdown ("## 6.1 Styringssystem"); a quote
    // that runs from a heading into its text omits the marker.
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/gu, "$1")
    // A hyphen or asterisk bullet at line start is a boundary too.
    .replace(/(?:^|\n)[ \t]*[-–*][ \t]+/gu, " ¦ ")
    // PDF text breaks words across lines with a hyphen.
    .replace(/(\p{Ll})-\s+(\p{Ll})/gu, "$1$2")
    .replace(/[«»“”"„]/gu, "")
    .replace(/[’‘`]/gu, "'")
    .replace(/[‐‑–—]/gu, "-")
    // Table cells and bullets stay boundaries ("¦"), so a quote is never
    // widened into a neighbouring row.
    .replace(/\s*[|•·▪]\s*/gu, " ¦ ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeQuoteMatchText(value: string) {
  return flattenQuoteText(value).toLocaleLowerCase("nb");
}

const normalizedSolutionTextCache = new WeakMap<
  ProjectDocumentDetail,
  {
    flat: string;
    whole: string;
    paragraphStarts: number[];
    sectionStarts: number[];
    pages: Array<{ page: number; text: string }>;
  }
>();

/** Where each paragraph or heading-led section of the raw text begins in
 * its flattened form: flattening removes the blank lines between them. A
 * list, or a paragraph after one ending in ":", continues the text before
 * it (Docling separates "Vi leverer:" from its bullets by a blank line). */
function paragraphStartOffsets(rawText: string, flat: string) {
  const starts: number[] = [];
  const sections: number[] = [];
  let cursor = 0;
  let previous = "";
  for (const paragraph of rawText.split(/\n[ \t]*\n|\n(?=[ \t]*#{1,6}[ \t])/u)) {
    const head = flattenQuoteText(paragraph).slice(0, 40);
    if (!head) continue;
    const at = flat.indexOf(head, cursor);
    if (at < 0) continue;
    const continues =
      /^\s*(?:[-–*•]|\d{1,2}[.)])\s/u.test(paragraph) && !/^\s*#/u.test(paragraph) ||
      (/:\s*$/u.test(previous) && !/^\s*#/u.test(paragraph));
    if (!continues) starts.push(at);
    if (/^\s*#/u.test(paragraph)) sections.push(at);
    cursor = at + head.length;
    previous = paragraph;
  }
  return { starts, sections };
}

function normalizedSolutionText(document: ProjectDocumentDetail) {
  const cached = normalizedSolutionTextCache.get(document);
  if (cached) return cached;
  const pages =
    document.file_format === "pdf"
      ? splitPdfPagesPreservingLines(document.raw_text)
      : [{ page: 0, text: document.raw_text }];
  const flat = flattenQuoteText(document.raw_text);
  const value = {
    flat,
    whole: flat.toLocaleLowerCase("nb"),
    ...(() => {
      const { starts, sections } = paragraphStartOffsets(document.raw_text, flat);
      return { paragraphStarts: starts, sectionStarts: sections };
    })(),
    pages: pages.map((page) => ({
      page: page.page,
      text: normalizeQuoteMatchText(page.text),
    })),
  };
  normalizedSolutionTextCache.set(document, value);
  return value;
}

const VERIFIED_QUOTE_MIN_CHARS = 30;
const VERIFIED_QUOTE_MAX_CHARS = 900;
const VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS = 300;
const BLANKET_COMPLIANCE_CLAIM =
  /\b(?:oppfyller|dekker|imøtekommer|ivaretar|tilfredsstiller|etterlever|innfrir|besvarer)\s+(?:alle|samtlige|hvert)\s+(?:krav|kravene|kravet|behov)\b|\b(?:alle|samtlige)\s+krav(?:ene)?\b[^.¦]{0,40}\b(?:oppfylles|dekkes|ivaretas|innfris|(?:er|blir)\s+(?:oppfylt|dekket|ivaretatt|innfridd|besvart))\b/iu;
// A remainder that only confirms ("Oppfylt", "Leverandøren bekrefter at
// kravet er oppfylt") after restating the requirement says nothing about how.
const CONFIRMATION_ONLY =
  /^[\s¦,.:;-]*(?:(?:leverandøren|vi|tilbyder|tilbyderen|løsningen)\s+)?(?:bekrefter|garanterer|forsikrer)?\s*(?:at\s+)?(?:dette\s+|det\s+)?(?:kravet\s+)?(?:er\s+)?(?:fullt\s+)?(?:oppfylt|dekket|ivaretatt|innfridd|oppfylles|dekkes|ivaretas|bekreftet|ja)?(?:\s+kravet)?[\s,.!¦]*(?:(?:som\s+)?standard(?:\s+i\s+(?:plattformen|løsningen|tjenesten))?)?[\s.!¦]*$/iu;
const NORWEGIAN_SUFFIXES = ["ingene", "ingen", "ering", "erte", "ende", "elig", "lige", "ene", "ane", "ing", "ert", "het", "lig", "er", "en", "et", "es", "te", "e", "s"];
const NEGATION = /\b(?:ikke|ingen|nei|unntatt|unntak|forutsetter|forbehold|mot\s+tillegg|tilleggspris)\b/iu;
const ABBREVIATION_BEFORE_DOT =
  /(?:^|[\s(¦])(?:f\.eks|bl\.a|ca|inkl|ekskl|eks|nr|kl|jf|jfr|evt|mv|osv|dvs|ref|pkt|kap|tlf|mill|mrd|ifm|iht|bla|pr|mnd|mht|vha|pga|vedr|stk|t\.o\.m|f\.o\.m|o\.l|m\.m|e\.l|\d{1,3}(?:\.\d{1,3})*)$/iu;
// Upper-case Norwegian function words ("SKAL", "IKKE") are not acronyms.
const UPPERCASE_STOPWORDS = new Set(["skal", "må", "bør", "ikke", "og", "eller", "alle", "kan", "som", "for", "med", "det", "den", "er", "en", "et", "av", "til", "på", "ved", "om", "nb", "obs"]);

function norwegianStem(word: string) {
  for (const suffix of NORWEGIAN_SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

// Words that appear in almost every requirement and answer and therefore do
// not show what a passage is about. Listed as words and stemmed with the
// same stemmer as the text, so every inflection is caught.
const GENERIC_REQUIREMENT_STEMS = new Set(
  [
    "leverandør", "leverandøren", "leverandørens", "oppdragsgiver", "oppdragsgiveren", "oppdragsgivers",
    "løsning", "løsningen", "løsningens", "tilbyder", "tilbyderen", "tilbyders", "tilbud", "tilbudet",
    "kunde", "kunden", "kundens", "krav", "kravet", "kravene", "skal", "kunne", "gjennom", "eventuelt",
    "herunder", "samtlige", "avtale", "avtalen", "minimum", "minst", "følgende", "andre", "annet", "eller",
    "være", "blir", "beskrive", "beskrivelse", "dokumentere", "dokumentert", "rutine", "rutiner", "sørge",
    "tilby", "tilbyr", "levere", "leverer", "leveres", "leveranse", "leveransen", "sikre", "ivareta",
    "inkludere", "omfatte", "gjelde", "gjelder", "system", "systemer", "tjeneste", "tjenesten", "tjenester",
    "oppdrag", "oppdraget", "støtte", "støtter", "etablere", "utføre", "ansvar", "ansvarlig", "håndtere",
    "bruke", "benytte", "knyttet", "relevante", "nødvendig",
  ].map(norwegianStem),
);

type TermSet = { strong: string[]; stems: string[] };

/** Distinctive terms of a text: Norwegian stems of longer words, and
 * acronyms or standard numbers (MFA, RPO, 27001) that are matched whole. */
function distinctiveTerms(text: string, genericStems: ReadonlySet<string> = new Set()): TermSet {
  const isGeneric = (stem: string) => GENERIC_REQUIREMENT_STEMS.has(stem) || genericStems.has(stem);
  const strong = [
    ...new Set(
      (flattenQuoteText(text).match(/\b(?:[A-ZÆØÅ]{2,6}\d{0,3}|\d{3,6})\b/gu) ?? [])
        .map((term) => term.toLocaleLowerCase("nb"))
        .filter((term) => !UPPERCASE_STOPWORDS.has(term) && !isGeneric(norwegianStem(term))),
    ),
  ];
  const stems = [
    ...new Set(
      normalizeQuoteMatchText(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4 && !/^\d+$/u.test(word))
        .map(norwegianStem)
        .filter((stem) => stem.length >= 4 && !isGeneric(stem) && !strong.includes(stem)),
    ),
  ];
  return { strong, stems };
}

function words(text: string) {
  return normalizeQuoteMatchText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Shared distinctive terms between a requirement and a passage. Strong
 * terms must match a whole word ("sso" is not "ssot"); a stem may start a
 * word or, if long, sit inside a compound ("kundedata"). */
function sharedTerms(terms: TermSet, passage: string) {
  const passageWords = words(passage);
  const normalizedPassage = passageWords.join(" ");
  const strong = terms.strong.filter((term) => passageWords.includes(term)).length;
  const stems = terms.stems.filter((stem) =>
    stem.length <= 5
      ? passageWords.some((word) => word.startsWith(stem))
      : normalizedPassage.includes(stem),
  ).length;
  return { strong, shared: strong + stems, total: terms.strong.length + terms.stems.length };
}

/**
 * Stems that occur in more than 15 % of a ledger's requirements (and in at
 * least three): in this tender they say little about which requirement a
 * passage answers. They lower certainty but never prevent a binding.
 */
export function requirementGenericStems(entries: RequirementLedgerEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const stem of distinctiveTerms(entry.text).stems) {
      counts.set(stem, (counts.get(stem) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(entries.length * 0.15));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([stem]) => stem));
}

/** Sentence and cell boundaries of flattened text; a full stop after an
 * abbreviation ("f.eks.", "pr.") or a list number ("3.2.") is not one. */
function sentenceBoundaries(flat: string) {
  const boundaries: number[] = [];
  for (const match of flat.matchAll(/[.!?](?=\s|$)|¦/gu)) {
    const at = match.index!;
    if (match[0] !== "¦" && ABBREVIATION_BEFORE_DOT.test(flat.slice(Math.max(0, at - 12), at))) continue;
    boundaries.push(at);
  }
  return boundaries;
}

/** The next sentence or cell after `from` (end of text is a boundary). */
function nextSegment(flat: string, boundaries: number[], from: number) {
  let start = from;
  let cellBoundaries = 0;
  while (start < flat.length && /[\s¦]/u.test(flat[start]!)) {
    if (flat[start] === "¦") cellBoundaries += 1;
    start += 1;
  }
  if (start >= flat.length) return null;
  const end = boundaries.find((at) => at >= start);
  const stop = end === undefined ? flat.length : flat[end] === "¦" ? end : end + 1;
  return {
    text: flat.slice(start, stop).trim(),
    end: stop,
    isCell: end !== undefined && flat[end] === "¦",
    // More than one cell boundary in between means an empty cell was skipped.
    adjacent: cellBoundaries <= 1,
  };
}

function nextCellText(flat: string, from: number) {
  const start = flat.indexOf("¦", from) + 1;
  if (start <= 0) return undefined;
  const end = flat.indexOf("¦", start);
  const text = flat.slice(start, end < 0 ? flat.length : end).trim();
  return text || undefined;
}

// A follow-up that limits the answer ("Dette gjelder kun produksjon").
const LIMITING = /\b(?:kun|bare|begrenset\s+til|opsjon|forutsatt|med\s+mindre)\b/iu;

// A clause that refers back to the quoted assertion ("men dette inngår
// ikke", "men kun for produksjon") qualifies it and belongs to the answer.
const REFERRING_CLAUSE = /^(?:(?:men|mens|samt|derimot)\s+)?(?:dette|det|disse|den|denne|kun|bare|ikke|unntatt|med\s+unntak)\b/iu;
// A follow-up that refers back to the answer ("Dette ...", "Unntatt ...").
// Across a blank line only an explicit back-reference qualifies the answer;
// a bare "Det"/"Dette" opens a new statement as often as it refers back.
const PARAGRAPH_BACK_REFERENCE =
  /^(?:dette\s+gjelder|det\s+gjelder|dette\s+omfatter|merk|merknad|unntatt|unntak|med\s+unntak|forbehold|forutsatt|gjelder|omfatter)\b/iu;
const REFERRING_START = /^(?:dette|det|denne|disse|dette gjelder|unntatt|unntak|men|merk|forutsatt|forbehold|med\s+unntak|merknad|leveres|gjelder|omfatter)\b/iu;

/**
 * The quote's own sentence (bounded by sentence ends, table cells and
 * bullets, with abbreviations skipped), split into clauses so that a refusal
 * about something else ("..., men telefonstøtte tilbys ikke") is not taken
 * as this requirement's answer. A following sentence or cell that refers
 * back to it or concerns the requirement is added. `complete` is false when
 * a boundary or a qualifying follow-up was out of reach.
 */
function answerPassage(
  flat: string,
  start: number,
  end: number,
  requirement: TermSet,
  paragraphStarts: number[] = [],
  sectionStarts: number[] = [],
) {
  const boundaries = sentenceBoundaries(flat);
  const before = boundaries.filter((at) => at < start).at(-1);
  const after = boundaries.find((at) => at >= end - 1);
  let complete = true;
  let sentenceStart = before === undefined ? 0 : before + 1;
  if (start - sentenceStart > VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS) {
    // The sentence start is out of reach: begin at the quote, never at an
    // arbitrary point that could open with a neighbour's text.
    sentenceStart = start;
    complete = false;
  }
  let sentenceEnd = after === undefined ? flat.length : after + (flat[after] === "¦" ? 0 : 1);
  if (sentenceEnd - end > VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS) {
    sentenceEnd = end;
    complete = false;
  }

  // Clauses of the own sentence; keep those overlapping the quote or naming
  // the requirement, set aside the rest.
  const clauseBreak = /\s*(?:,\s*(?=(?:men|mens|samt|derimot)\b)|;\s*)/giu;
  const clauses: Array<{ from: number; to: number }> = [];
  let clauseStart = sentenceStart;
  for (const match of flat.slice(sentenceStart, sentenceEnd).matchAll(clauseBreak)) {
    const at = sentenceStart + match.index!;
    clauses.push({ from: clauseStart, to: at });
    clauseStart = at + match[0].length;
  }
  clauses.push({ from: clauseStart, to: sentenceEnd });
  // Keep the contiguous run of clauses around the quote, extended by
  // neighbours that refer back to it or name the requirement; the stored
  // answer is always a verbatim span, never clauses joined across a gap.
  let setAsideNegation = false;
  const belongs = (clause: { from: number; to: number }) => {
    const text = flat.slice(clause.from, clause.to);
    return sharedTerms(requirement, text).shared > 0 || REFERRING_CLAUSE.test(text.trim());
  };
  const quoted = clauses
    .map((clause, index) => (clause.to > start && clause.from < end ? index : -1))
    .filter((index) => index >= 0);
  let first = quoted[0] ?? 0;
  let last = quoted.at(-1) ?? 0;
  while (first > 0 && belongs(clauses[first - 1]!)) first -= 1;
  while (last < clauses.length - 1 && belongs(clauses[last + 1]!)) last += 1;
  for (const [index, clause] of clauses.entries()) {
    if ((index < first || index > last) && NEGATION.test(flat.slice(clause.from, clause.to))) {
      setAsideNegation = true;
    }
  }
  const own = flat
    .slice(clauses[first]!.from, clauses[last]!.to)
    .replace(/^[\s¦,;]+|[\s¦,;]+$/gu, "");

  let passage = own;
  const following = nextSegment(flat, boundaries, sentenceEnd);
  // A new section is another answer. So is a new paragraph, unless it
  // refers back to this one ("Dette gjelder kun …", "Merk: …") or restricts
  // the requirement itself ("Kundedata i testmiljøet krypteres ikke.").
  const crosses = (starts: number[]) =>
    following !== null && starts.some((at) => at >= sentenceEnd && at < following.end);
  const newParagraph = crosses(paragraphStarts);
  const next =
    following &&
    !crosses(sectionStarts) &&
    (!newParagraph ||
      PARAGRAPH_BACK_REFERENCE.test(following.text) ||
      ((NEGATION.test(following.text) || LIMITING.test(following.text)) &&
        sharedTerms(requirement, following.text).shared > 0))
      ? following
      : null;
  if (next) {
    // A follow-up that refers back qualifies the answer even without a
    // negation ("Dette gjelder kun produksjonsmiljøet"); one that names the
    // requirement does when it negates or limits it.
    const restricts = NEGATION.test(next.text) || LIMITING.test(next.text);
    const qualifies =
      REFERRING_START.test(next.text) || (restricts && sharedTerms(requirement, next.text).shared > 0);
    if (qualifies && next.text.length <= VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS) {
      passage = `${own}${next.isCell ? " | " : " "}${next.text}`;
    } else if (qualifies) {
      complete = false;
    }
    // A restriction right after the answer (an option, a scope limit, a
    // negation) may apply to it even without naming it, whether it ends in
    // punctuation or at a cell boundary: never "Godt".
    if (restricts) complete = false;
    // Look further through the same paragraph or cell, within the context
    // budget: "Dette er standard. Gjelder kun produksjonsmiljøet."
    let cursor = next.end;
    let budget = VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS - next.text.length;
    while (complete && !next.isCell && !newParagraph && budget > 0) {
      if (/^\s*¦/u.test(flat.slice(cursor))) break;
      const further = nextSegment(flat, boundaries, cursor);
      if (!further || !further.adjacent) break;
      // A new paragraph or section ("Tilleggstjenester") is another answer.
      if (paragraphStarts.some((at) => at >= cursor && at < further.end)) break;
      if (NEGATION.test(further.text) || LIMITING.test(further.text)) complete = false;
      if (further.isCell) break;
      budget -= further.text.length;
      cursor = further.end;
    }
  }
  return {
    own,
    passage,
    complete,
    setAsideNegation,
    // The cell after the quote's own cell, for a row whose first cells only
    // restate the requirement.
    // Also when a full stop ends the cell before its "|".
    // The whole next cell, up to its own boundary, not its first sentence.
    nextCell:
      next?.adjacent && after !== undefined && (flat[after] === "¦" || /^\s*¦/u.test(flat.slice(sentenceEnd)))
        ? nextCellText(flat, sentenceEnd)
        : undefined,
  };
}

/** Removes the restated requirement from a passage, compared as words so
 * punctuation ("1 time;" vs "1 time.") does not hide the repetition. */
function withoutRestatedRequirement(passage: string, requirementText: string) {
  const passageWords = words(passage);
  const requirementWords = words(requirementText);
  if (requirementWords.length < 3) return { pureRestatement: false, remainder: passageWords.join(" ") };
  for (let at = 0; at + requirementWords.length <= passageWords.length; at += 1) {
    if (requirementWords.every((word, index) => passageWords[at + index] === word)) {
      const rest = [...passageWords.slice(0, at), ...passageWords.slice(at + requirementWords.length)];
      return { pureRestatement: rest.length === 0, remainder: rest.join(" ") };
    }
  }
  const joinedRequirement = requirementWords.join(" ");
  const pureRestatement = joinedRequirement.includes(passageWords.join(" "));
  return { pureRestatement, remainder: passageWords.join(" ") };
}

export type VerifiedSolutionQuote = {
  entry: RequirementLedgerEntry;
  /** The passage shares few distinctive terms with the requirement, its
   * context was cut, or it carries a negation or a bare confirmation: it
   * may not support a "Godt". */
  uncertain: boolean;
};

/** Whether a quote occurs verbatim in the solution document, so a quote
 * that could not be bound is not reported as an absent answer. */
export function solutionDocumentContainsQuote(
  quote: string | undefined,
  solutionDocument: ProjectDocumentDetail,
) {
  const normalized = normalizeQuoteMatchText(String(quote ?? ""));
  return normalized.length >= VERIFIED_QUOTE_MIN_CHARS &&
    normalizedSolutionText(solutionDocument).whole.includes(normalized);
}

/**
 * Binds a requirement without a matched answer row to a passage of the
 * solution document that the model quoted. The quote must occur verbatim
 * (modulo whitespace, line-break hyphens, ligatures and quote marks); the
 * stored answer is its own sentence or cell plus a qualifying follow-up, not
 * the model's excerpt. Blanket compliance claims and pure restatements are
 * rejected, and a passage sharing no distinctive term with the requirement
 * is not bound. Weak overlap, cut context, an extra negation or a bare
 * confirmation bind as uncertain, because failed word matching alone does
 * not prove that an answer is absent. The existing answer checks (declines,
 * deferred confirmation, attachments) then judge the stored passage.
 */
export function bindVerifiedSolutionQuote(input: {
  entry: RequirementLedgerEntry;
  quote: string | undefined;
  assessment?: string;
  solutionDocument: ProjectDocumentDetail;
  /** Stems that are generic in this tender (see requirementGenericStems). */
  genericStems?: ReadonlySet<string>;
}): VerifiedSolutionQuote | null {
  if (substantiveRequirementAnswerExcerpt(input.entry)) return null;
  // A model that finds no answer must not be turned into a weak answer.
  if (normalizeRequirementCoverageAssessment(input.assessment) === "Mangler") return null;
  const quote = String(input.quote ?? "").replace(/\s+/gu, " ").trim();
  if (
    quote.length < VERIFIED_QUOTE_MIN_CHARS ||
    quote.length > VERIFIED_QUOTE_MAX_CHARS ||
    /\.\.\.|…|\[\.\.\.\]/u.test(quote)
  ) {
    return null;
  }
  const normalizedQuote = normalizeQuoteMatchText(quote);
  const solution = normalizedSolutionText(input.solutionDocument);
  const start = solution.whole.indexOf(normalizedQuote);
  if (start < 0) return null;

  const requirementSource = `${input.entry.text} ${input.entry.heading}`;
  // Binding is decided on the general vocabulary only; tender-wide frequent
  // words merely lower certainty, so a section of related requirements
  // ("sikkerhetskopi") does not lose its topic word.
  const baseTerms = distinctiveTerms(requirementSource);
  const tenderTerms = distinctiveTerms(requirementSource, input.genericStems);
  const located = answerPassage(
    solution.flat,
    start,
    start + normalizedQuote.length,
    baseTerms,
    solution.paragraphStarts,
    solution.sectionStarts,
  );
  const { complete, setAsideNegation } = located;
  let { own, passage } = located;
  let { pureRestatement, remainder } = withoutRestatedRequirement(own, input.entry.text);
  if (pureRestatement && located.nextCell && located.nextCell.length <= VERIFIED_QUOTE_SENTENCE_CONTEXT_CHARS) {
    // A table row restating the requirement: its next cell is the answer.
    own = `${own} | ${located.nextCell}`;
    passage = own;
    ({ pureRestatement, remainder } = withoutRestatedRequirement(own, input.entry.text));
  }
  if (pureRestatement) return null;
  const normalizedPassage = normalizeQuoteMatchText(passage);
  if (BLANKET_COMPLIANCE_CLAIM.test(normalizedPassage)) return null;
  const bareConfirmation = remainder.length < 20 || CONFIRMATION_ONLY.test(remainder);
  if (sharedTerms(baseTerms, own).shared === 0) return null;

  // Certainty is judged on what the passage adds beyond the restatement.
  const tenderOverlap = sharedTerms(tenderTerms, remainder);
  const newNegation = NEGATION.test(normalizedPassage) && !NEGATION.test(normalizedQuote);
  const uncertain =
    !complete ||
    newNegation ||
    setAsideNegation ||
    bareConfirmation ||
    (tenderOverlap.strong === 0 &&
      (tenderOverlap.total === 0 || tenderOverlap.shared < Math.min(2, tenderOverlap.total)));

  const quotePrefix = normalizedPassage.slice(0, 60);
  const page = solution.pages.find((candidate) =>
    candidate.page > 0 && candidate.text.includes(quotePrefix),
  )?.page;
  const answerReference = page
    ? `${input.solutionDocument.title}, side ${page}`
    : input.solutionDocument.title;

  return {
    uncertain,
    entry: {
      ...input.entry,
      sourceExcerpt: compactText(
        [
          requirementSourceExcerptWithoutAnswer(input.entry).trim().replace(/\|\s*$/u, "").trim() ||
            `Kravgrunnlag: ${input.entry.text}`,
          `Svarrad: ${passage}`,
        ].join(" | "),
        1800,
      ),
      answerExcerpt: passage,
      answerEvidenceExcerpt: passage,
      answerDocumentId: input.solutionDocument.id,
      answerDocumentTitle: input.solutionDocument.title,
      answerReference,
    },
  };
}

export function coverageItemFromBatchRow(input: {
  row: RequirementCoverageBatchAnswer | undefined;
  entry: RequirementLedgerEntry;
  orderIndex: number;
}): RequirementCoverageItem {
  const row = input.row;
  const fallbackReference = requirementCoverageRef(input.entry);
  const fullReference = requirementFullReference(input.entry);
  const sourceReference = requirementCoverageSource(input.entry);
  const normalizedAssessment = normalizeRequirementCoverageAssessment(
    row?.assessment ?? row?.vurdering,
  );
  const sourceBoundEvidence = deterministicCoverageEvidence({
    entry: input.entry,
    assessment: normalizedAssessment,
  });
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: input.entry,
    assessment: normalizedAssessment,
    rationale: compactText(row?.rationale ?? row?.begrunnelse ?? "", 460),
    // A model may quote the requirement, a neighbouring row, or a fabricated
    // sentence as evidence. Assessment prose may still come from the model,
    // but persisted evidence is always rebuilt from the matched ledger row.
    evidence: sourceBoundEvidence,
    recommendation: compactText(
      row?.recommendation ?? row?.anbefaling ?? "",
      520,
    ),
  });

  return {
    order_index: input.orderIndex,
    reference: compactText(fallbackReference, 220),
    full_reference: compactText(fullReference || sourceReference, 700),
    source_reference: compactText(sourceReference, 700),
    source_document_id: input.entry.documentId ?? null,
    source_document_title: input.entry.documentTitle ?? null,
    answer_document_id: input.entry.answerDocumentId ?? null,
    answer_document_title: input.entry.answerDocumentTitle ?? null,
    requirement_subtitle: requirementSubtitle(input.entry),
    heading_path: requirementHeadingPath(input.entry),
    page_range: requirementPageRange(input.entry) || null,
    table_id: input.entry.tableId || null,
    requirement: compactText(input.entry.text, 700),
    assessment: corrected.assessment,
    rationale: corrected.rationale,
    evidence:
      deterministicCoverageEvidence({
        entry: input.entry,
        assessment: corrected.assessment,
      }) || corrected.evidence,
    recommendation: corrected.recommendation,
  };
}

function coverageEvidenceMatchesEntry(input: {
  entry: RequirementLedgerEntry;
  evidence: string;
  answerBoundOnly?: boolean;
}) {
  const evidence = normalizeCoverageEvidenceText(input.evidence);
  if (evidence.length < 24) {
    return false;
  }

  const sources = (input.answerBoundOnly
    ? [input.entry.answerExcerpt, input.entry.answerEvidenceExcerpt]
    : [
        input.entry.answerExcerpt,
        input.entry.answerEvidenceExcerpt,
        input.entry.sourceExcerpt,
        input.entry.text,
      ])
    .map((value) => normalizeCoverageEvidenceText(value ?? ""))
    .filter(Boolean);

  return sources.some(
    (source) =>
      source.includes(evidence) ||
      evidence.includes(source.slice(0, Math.min(source.length, 160))),
  );
}

/**
 * Keep coverage evidence as a literal prefix of the normalized source cell.
 * `compactText` appends an ellipsis when it truncates, which makes the stored
 * value cease to be a substring of the answer and breaks provenance checks.
 */
export function exactCoverageEvidenceExcerpt(
  value: string | null | undefined,
  limit = 420,
) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }

  const boundedLimit = Math.max(1, Math.floor(limit));
  const candidate = normalized.slice(0, boundedLimit + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const end =
    wordBoundary >= Math.floor(boundedLimit * 0.75)
      ? wordBoundary
      : boundedLimit;
  const previousCodeUnit = normalized.charCodeAt(end - 1);
  const nextCodeUnit = normalized.charCodeAt(end);
  const safeEnd =
    end > 0 &&
    end < normalized.length &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
      ? end - 1
      : end;
  return normalized.slice(0, safeEnd).trimEnd();
}

function deterministicCoverageEvidence(input: {
  entry: RequirementLedgerEntry;
  assessment: RequirementCoverageItem["assessment"];
}) {
  const matchedAnswer = substantiveRequirementAnswerExcerpt(input.entry);
  const matchedAnswerBasis = String(
    input.entry.answerEvidenceExcerpt ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const answerBoundEvidence =
    matchedAnswer.length >= 16
      ? matchedAnswer
      : matchedAnswerBasis.length >= 16
        ? matchedAnswerBasis
        : "";

  if (input.assessment !== "Mangler" && answerBoundEvidence) {
    return exactCoverageEvidenceExcerpt(answerBoundEvidence);
  }

  return exactCoverageEvidenceExcerpt(
    input.entry.sourceExcerpt || input.entry.text,
  );
}

export function assertRequirementCoverageItemsAreReviewable(items: RequirementCoverageItem[]) {
  const broken = items.filter(
    (item) =>
      !item.rationale.trim() ||
      !item.evidence.trim() ||
      !item.recommendation.trim() ||
      (item.assessment === "Uklart" &&
        !item.rationale.trim() &&
        !item.recommendation.trim()),
  );

  if (broken.length) {
    throw new Error(
      `Kravdekningen er ikke produksjonsklar: ${broken.length} vurderingsrader mangler begrunnelse, evidence eller anbefaling.`,
    );
  }
}

export function emptyRequirementCoverage(summary = ""): RequirementCoverage {
  return {
    total_requirements: 0,
    assessed_requirements: 0,
    good: 0,
    weak: 0,
    missing: 0,
    unclear: 0,
    confidence: "Lav",
    coverage_summary: summary,
    items: [],
  };
}

function countRequirementCoverage(items: RequirementCoverageItem[]) {
  return {
    good: items.filter((item) => item.assessment === "Godt").length,
    weak: items.filter((item) => item.assessment === "Dårlig").length,
    missing: items.filter((item) => item.assessment === "Mangler").length,
    unclear: items.filter((item) => item.assessment === "Uklart").length,
  };
}

function filterSyntheticCoverageItems(items: RequirementCoverageItem[]) {
  return items;
}

function normalizeCoverageLedgerConfidence(
  raw: unknown,
): RequirementCoverage["ledger_confidence"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const value: Untrusted<NonNullable<RequirementCoverage["ledger_confidence"]>> =
    raw;

  const level =
    value.level === "high" ||
    value.level === "medium" ||
    value.level === "low"
      ? value.level
      : "low";

  return {
    level,
    score:
      typeof value.score === "number" && Number.isFinite(value.score)
        ? Math.max(0, Math.min(1, value.score))
        : 0,
    requirement_count:
      typeof value.requirement_count === "number" &&
      Number.isFinite(value.requirement_count)
        ? Math.max(0, Math.round(value.requirement_count))
        : 0,
    source_locator_coverage:
      typeof value.source_locator_coverage === "number" &&
      Number.isFinite(value.source_locator_coverage)
        ? Math.max(0, Math.min(1, value.source_locator_coverage))
        : 0,
    structured_entry_ratio:
      typeof value.structured_entry_ratio === "number" &&
      Number.isFinite(value.structured_entry_ratio)
        ? Math.max(0, Math.min(1, value.structured_entry_ratio))
        : 0,
    explicit_reference_ratio:
      typeof value.explicit_reference_ratio === "number" &&
      Number.isFinite(value.explicit_reference_ratio)
        ? Math.max(0, Math.min(1, value.explicit_reference_ratio))
        : 0,
    generated_reference_count:
      typeof value.generated_reference_count === "number" &&
      Number.isFinite(value.generated_reference_count)
        ? Math.max(0, Math.round(value.generated_reference_count))
        : 0,
    extraction_methods: Array.isArray(value.extraction_methods)
      ? value.extraction_methods
          .map((item) => compactText(item, 80))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    reasons: Array.isArray(value.reasons)
      ? value.reasons
          .map((item) => compactText(item, 120))
          .filter(Boolean)
          .slice(0, 16)
      : [],
  };
}

export function coverageConfidenceFromLedger(
  ledgerConfidence: RequirementLedgerConfidence,
  complete: boolean,
): RequirementCoverage["confidence"] {
  if (!complete || ledgerConfidence.level === "low") {
    return "Lav";
  }

  return ledgerConfidence.level === "high" ? "Høy" : "Middels";
}

export function normalizeSolutionRequirementCoverage(
  value: unknown,
): RequirementCoverage {
  const source = untrustedObject<RequirementCoverage>(value);
  const rawItems = untrustedRows<RequirementCoverage["items"][number]>(
    source.items,
  );
  const sortedItems = sortByRequirementOrder(
    rawItems
      .map((item) => ({
        order_index:
          typeof item.order_index === "number" && Number.isFinite(item.order_index)
            ? Math.max(0, Math.round(item.order_index))
            : undefined,
        reference: compactText(item.reference ?? "", 220),
        full_reference: compactText(item.full_reference ?? "", 700),
        source_reference: compactText(item.source_reference ?? "", 700),
        source_document_id: item.source_document_id
          ? compactText(item.source_document_id, 120)
          : null,
        source_document_title: item.source_document_title
          ? compactText(item.source_document_title, 220)
          : null,
        answer_document_id: item.answer_document_id
          ? compactText(item.answer_document_id, 120)
          : null,
        answer_document_title: item.answer_document_title
          ? compactText(item.answer_document_title, 220)
          : null,
        requirement_subtitle: item.requirement_subtitle
          ? compactText(item.requirement_subtitle, 260)
          : null,
        heading_path: Array.isArray(item.heading_path)
          ? item.heading_path
              .map((part) => compactText(part, 180))
              .filter(Boolean)
              .slice(0, 8)
          : [],
        page_range: item.page_range ? compactText(item.page_range, 80) : null,
        table_id: item.table_id ? compactText(item.table_id, 80) : null,
        requirement: compactText(item.requirement ?? "", 700),
        assessment: normalizeRequirementCoverageAssessment(item.assessment),
        rationale: compactText(item.rationale ?? "", 460),
        evidence: compactText(item.evidence ?? "", 420),
        recommendation: compactText(item.recommendation ?? "", 520),
      }))
      .filter((item) => item.reference || item.requirement),
    (item, index) => ({
      reference: item.reference,
      sourceReference: item.source_reference,
      group: item.requirement_subtitle ?? item.table_id,
      orderIndex: item.order_index,
      fallbackIndex: index,
    }),
  );
  // `order_index` is persisted as a zero-based ledger position. It is not a
  // display number and must never be trusted from an AI response or legacy
  // payload. Canonicalize only after the final ordering step so 1..N input,
  // gaps, duplicates and stale indexes cannot escape normalization.
  const orderedItems = sortedItems.map((item, orderIndex) => ({
    ...item,
    order_index: orderIndex,
  }));
  const filteredItems = filterSyntheticCoverageItems(orderedItems).map(
    (item, orderIndex) => ({
      ...item,
      order_index: orderIndex,
    }),
  );
  const items = orderedItems;
  const counts = countRequirementCoverage(filteredItems);
  const sourceTotalRequirements =
    typeof source.total_requirements === "number" &&
    Number.isFinite(source.total_requirements)
      ? Math.max(0, Math.round(source.total_requirements))
      : items.length;
  const totalRequirements =
    filteredItems.length !== items.length
      ? filteredItems.length
      : sourceTotalRequirements;
  const sourceAssessedRequirements =
    typeof source.assessed_requirements === "number" &&
    Number.isFinite(source.assessed_requirements)
      ? Math.max(0, Math.round(source.assessed_requirements))
      : filteredItems.length;
  const assessedRequirements =
    filteredItems.length !== items.length
      ? filteredItems.length
      : sourceAssessedRequirements;
  const confidence =
    source.confidence === "Høy" ||
    source.confidence === "Middels" ||
    source.confidence === "Lav"
      ? source.confidence
      : filteredItems.length >= totalRequirements && totalRequirements > 0
        ? "Høy"
        : filteredItems.length > 0
          ? "Middels"
          : "Lav";
  const coverageSummary =
    compactText(source.coverage_summary ?? "", 900) ||
    (filteredItems.length
      ? `${filteredItems.length} av ${totalRequirements || filteredItems.length} identifiserte krav er vurdert.`
      : "");

  return {
    total_requirements: totalRequirements,
    assessed_requirements: assessedRequirements,
    good: counts.good,
    weak: counts.weak,
    missing: counts.missing,
    unclear: counts.unclear,
    confidence,
    coverage_summary: coverageSummary,
    ledger_confidence: normalizeCoverageLedgerConfidence(source.ledger_confidence),
    items: filteredItems,
  };
}

export function buildRequirementCoverageSummary(items: RequirementCoverageItem[]) {
  const counts = countRequirementCoverage(items);
  const total = items.length;
  if (!total) {
    return "Ingen kravdekning kunne bygges fra dokumentstrukturen.";
  }

  return [
    `${total} krav ble identifisert og vurdert fra Bilag 2-strukturen.`,
    `${counts.good} er vurdert som gode, ${counts.weak} som dårlige, ${counts.missing} mangler svar og ${counts.unclear} er uklare.`,
    "Krav med Mangler, Dårlig eller Uklart bør prioriteres i rettingen før tilbudet kvalitetssikres.",
  ].join(" ");
}

export function buildRequirementCoverageRegistry(
  coverage: RequirementCoverage,
) {
  return coverage.items.map((item, index) => ({
    nr: Number.isFinite(item.order_index) ? item.order_index! + 1 : index + 1,
    reference: item.reference,
    source_document_id: item.source_document_id ?? "",
    source_reference: compactText(item.source_reference, 159),
    assessment: item.assessment,
    page_range: item.page_range ?? "",
    table_id: item.table_id ?? "",
    requirement_subtitle: item.requirement_subtitle ?? "",
    requirement: compactText(item.requirement, 179),
  }));
}

function boundedRequirementCoverageRegistry(coverage: RequirementCoverage) {
  const fullRegistry = buildRequirementCoverageRegistry(coverage);
  const fullRegistrySha256 = createHash("sha256")
    .update(JSON.stringify(fullRegistry))
    .digest("hex");
  if (
    fullRegistry.length <= REQUIREMENT_COVERAGE_EVALUATION_REGISTRY_MAX_ROWS
  ) {
    return {
      rows: fullRegistry,
      total: fullRegistry.length,
      omitted: 0,
      sha256: fullRegistrySha256,
    };
  }

  const selectedIndexes = new Set<number>();
  const registryLimit = REQUIREMENT_COVERAGE_EVALUATION_REGISTRY_MAX_ROWS;
  const addDistributedIndexes = (
    candidates: number[],
    requestedSlots: number,
  ) => {
    const slots = Math.min(requestedSlots, candidates.length);
    if (slots <= 0) {
      return;
    }
    if (slots === 1) {
      selectedIndexes.add(candidates[Math.floor((candidates.length - 1) / 2)]);
      return;
    }
    for (let slot = 0; slot < slots; slot += 1) {
      selectedIndexes.add(
        candidates[
          Math.round((slot * (candidates.length - 1)) / (slots - 1))
        ],
      );
    }
  };

  // Preserve both ends of the authoritative ledger so a bounded registry
  // cannot silently hide requirements added at the end of a large corpus.
  selectedIndexes.add(0);
  if (registryLimit > 1) {
    selectedIndexes.add(fullRegistry.length - 1);
  }
  const nonGoodIndexes = coverage.items.flatMap((item, index) =>
    item.assessment !== "Godt" ? [index] : [],
  );
  addDistributedIndexes(
    nonGoodIndexes.filter((index) => !selectedIndexes.has(index)),
    registryLimit - selectedIndexes.size,
  );
  addDistributedIndexes(
    fullRegistry
      .map((_, index) => index)
      .filter((index) => !selectedIndexes.has(index)),
    registryLimit - selectedIndexes.size,
  );
  for (
    let index = 0;
    selectedIndexes.size < registryLimit &&
    index < fullRegistry.length;
    index += 1
  ) {
    selectedIndexes.add(index);
  }
  const rows = [...selectedIndexes]
    .sort((left, right) => left - right)
    .slice(0, registryLimit)
    .map((index) => fullRegistry[index]);
  return {
    rows,
    total: fullRegistry.length,
    omitted: fullRegistry.length - rows.length,
    sha256: fullRegistrySha256,
  };
}

function requirementCoverageDetail(
  item: RequirementCoverageItem,
  fallbackIndex = 0,
) {
  return {
    nr: Number.isFinite(item.order_index)
      ? item.order_index! + 1
      : fallbackIndex + 1,
    reference: item.reference,
    full_reference: item.full_reference ?? "",
    source_reference: item.source_reference,
    source_document_id: item.source_document_id ?? "",
    source_document_title: item.source_document_title ?? "",
    answer_document_id: item.answer_document_id ?? "",
    answer_document_title: item.answer_document_title ?? "",
    requirement_subtitle: item.requirement_subtitle ?? "",
    heading_path: item.heading_path ?? [],
    page_range: item.page_range ?? "",
    table_id: item.table_id ?? "",
    assessment: item.assessment,
    requirement: item.requirement,
    rationale: item.rationale,
    evidence: item.evidence,
    recommendation: item.recommendation,
  };
}

function requirementCoverageSectionKey(item: RequirementCoverageItem) {
  return [
    item.source_document_id ?? item.source_document_title ?? "ukjent-dokument",
    item.requirement_subtitle ??
      item.heading_path?.at(-1) ??
      item.table_id ??
      item.page_range ??
      "ukjent-seksjon",
  ].join("::");
}

export function selectDistributedGoodCoverageExamples(
  items: RequirementCoverageItem[],
) {
  const goodItems = items.filter((item) => item.assessment === "Godt");
  if (!goodItems.length) {
    return [];
  }

  const selected: RequirementCoverageItem[] = [];
  const selectedItems = new Set<RequirementCoverageItem>();
  const seenDocuments = new Set<string>();
  const seenSections = new Set<string>();
  const add = (item: RequirementCoverageItem) => {
    if (selected.length >= 5 || selectedItems.has(item)) {
      return;
    }
    selected.push(item);
    selectedItems.add(item);
    seenDocuments.add(item.source_document_id ?? item.source_document_title ?? "");
    seenSections.add(requirementCoverageSectionKey(item));
  };

  for (const item of goodItems) {
    const documentKey = item.source_document_id ?? item.source_document_title ?? "";
    if (!seenDocuments.has(documentKey)) {
      add(item);
    }
  }
  for (const item of goodItems) {
    if (!seenSections.has(requirementCoverageSectionKey(item))) {
      add(item);
    }
  }
  for (const item of goodItems) {
    if (selected.length >= Math.min(3, goodItems.length)) {
      break;
    }
    add(item);
  }

  return selected.map((item) =>
    requirementCoverageDetail(item, items.indexOf(item)),
  );
}

export function selectDistributedNonGoodCoverageDetails(
  items: RequirementCoverageItem[],
  options: {
    maxRows?: number;
    charBudget?: number;
  } = {},
) {
  const maxRows =
    typeof options.maxRows === "number" && Number.isFinite(options.maxRows)
      ? Math.max(0, Math.floor(options.maxRows))
      : REQUIREMENT_COVERAGE_EVALUATION_DETAIL_MAX_ROWS;
  const charBudget =
    typeof options.charBudget === "number" &&
    Number.isFinite(options.charBudget)
      ? Math.max(2, Math.floor(options.charBudget))
      : REQUIREMENT_COVERAGE_EVALUATION_DETAIL_CHAR_BUDGET;
  const severity = (item: RequirementCoverageItem) => {
    switch (item.assessment) {
      case "Mangler":
        return 0;
      case "Dårlig":
        return 1;
      case "Uklart":
        return 2;
      default:
        return 3;
    }
  };
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.assessment !== "Godt")
    .sort(
      (left, right) =>
        severity(left.item) - severity(right.item) || left.index - right.index,
    );

  const details: ReturnType<typeof requirementCoverageDetail>[] = [];
  let detailCharacters = 2;
  const selectedIndexes = new Set<number>();
  const seenDocuments = new Set<string>();
  const seenSections = new Set<string>();
  const documentKey = (item: RequirementCoverageItem) =>
    item.source_document_id ?? item.source_document_title ?? "ukjent-dokument";
  const add = (candidate: (typeof candidates)[number] | undefined) => {
    if (
      !candidate ||
      details.length >= maxRows ||
      selectedIndexes.has(candidate.index)
    ) {
      return false;
    }

    const detail = requirementCoverageDetail(candidate.item, candidate.index);
    const nextDetailCharacters =
      detailCharacters + JSON.stringify(detail).length + (details.length ? 1 : 0);
    if (nextDetailCharacters > charBudget) {
      return false;
    }

    details.push(detail);
    detailCharacters = nextDetailCharacters;
    selectedIndexes.add(candidate.index);
    seenDocuments.add(documentKey(candidate.item));
    seenSections.add(requirementCoverageSectionKey(candidate.item));
    return true;
  };

  for (const assessment of ["Mangler", "Dårlig", "Uklart"] as const) {
    add(candidates.find((candidate) => candidate.item.assessment === assessment));
  }
  for (const candidate of candidates) {
    if (!seenDocuments.has(documentKey(candidate.item))) {
      add(candidate);
    }
  }
  for (const candidate of candidates) {
    if (!seenSections.has(requirementCoverageSectionKey(candidate.item))) {
      add(candidate);
    }
  }
  for (const candidate of candidates) {
    add(candidate);
  }

  return {
    details,
    metadata: {
      total_non_good_requirements: candidates.length,
      detailed_non_good_requirements: details.length,
      omitted_non_good_requirements: candidates.length - details.length,
      detail_row_budget: maxRows,
      detail_character_budget: charBudget,
      detail_characters: detailCharacters,
      selection_strategy: "severity_then_distributed_document_and_section",
    },
  };
}

export function buildRequirementCoverageEvaluationPayload(
  coverage: RequirementCoverage,
  options: {
    detailMaxRows?: number;
    detailCharBudget?: number;
  } = {},
) {
  const registry = boundedRequirementCoverageRegistry(coverage);
  const nonGoodDetails = selectDistributedNonGoodCoverageDetails(
    coverage.items,
    {
      maxRows: options.detailMaxRows,
      charBudget: options.detailCharBudget,
    },
  );
  return {
    total_requirements: coverage.total_requirements,
    assessed_requirements: coverage.assessed_requirements,
    good: coverage.good,
    weak: coverage.weak,
    missing: coverage.missing,
    unclear: coverage.unclear,
    confidence: coverage.confidence,
    coverage_summary: coverage.coverage_summary,
    coverage_registry: registry.rows,
    coverage_registry_total: registry.total,
    coverage_registry_omitted: registry.omitted,
    coverage_registry_sha256: registry.sha256,
    non_good_detail_selection: nonGoodDetails.metadata,
    prioritized_non_good_requirements: nonGoodDetails.details,
    good_examples: selectDistributedGoodCoverageExamples(coverage.items),
  };
}

export function buildRequirementCoverageEvaluationContext(
  coverage: RequirementCoverage,
  options: {
    detailMaxRows?: number;
    detailCharBudget?: number;
  } = {},
) {
  if (!coverage.items.length) {
    return "";
  }

  return buildDelimitedContext(
    "Kravdekning fra egen batchvurdering",
    JSON.stringify(buildRequirementCoverageEvaluationPayload(coverage, options)),
  );
}

export async function buildRequirementCoverageLedger(document: ProjectDocumentDetail) {
  const withTitle = (entries: RequirementLedgerEntry[]) =>
    sortRequirementLedgerInDocumentOrder(
      entries.map((entry) => ({
        ...entry,
        documentId: document.id,
        documentTitle: document.title,
      })),
    );

  // Keep artifact generation and the solution-evaluation fallback on one
  // canonical extraction path. Re-running generic dedupe after the PDF's
  // source-bound finalization can rehydrate an uncorrected pre-answer excerpt
  // and make the same source document produce different requirement text.
  return withTitle(await extractRequirementLedgerForDocumentCore(document));
}

export async function buildRequirementCoverageLedgerFromDocuments(
  documents: ProjectDocumentDetail[],
) {
  const requirementLedgerResults = await mapWithConcurrency(
    documents,
    3,
    async (document) => ({
      document,
      ledger: await buildRequirementCoverageLedger(document),
    }),
  );

  return sortRequirementLedgerInDocumentOrder(
    canonicalizeRequirementSourceLedger({
      sourceDocuments: documents,
      requirementLedgerResults,
    }),
  );
}

function normalizeCoverageRequirementEntry(entry: RequirementLedgerEntry) {
  return {
    ...entry,
    text: stripAnswerTextFromRequirement(entry.text),
  };
}

function normalizedRequirementMatchText(entry: RequirementLedgerEntry) {
  return normalizeComparableText(stripAnswerTextFromRequirement(entry.text));
}

function normalizedStrongRequirementRowIdentity(value: string | undefined) {
  const normalized = normalizedCoverageRef(value ?? "");
  if (
    !normalized ||
    /^(?:PDFKRAV-?ID|DOKUMENTTEKST|MARKDOWNKRAVBESVARELSE|KRAVBESVARELSE|KRAVTABELL|TABELL|TABLE|REQUIREMENTS?)$/i.test(
      normalized,
    )
  ) {
    return "";
  }
  return normalized;
}

function normalizedSourceLedgerBinding(entry: RequirementLedgerEntry) {
  return normalizedCoverageRef(requirementCoverageSource(entry));
}

function normalizedSolutionSourceBinding(entry: RequirementLedgerEntry) {
  return normalizedCoverageRef(entry.answerReference ?? "");
}

function normalizedRequirementMatchId(entry: RequirementLedgerEntry) {
  const normalizedId = normalizedCoverageRef(entry.id);
  if (isGeneratedRequirementId(entry.id)) {
    return normalizedId;
  }

  const explicitIds = [
    ...new Set(
      detectExplicitRequirementIds(entry.id).map((id) =>
        normalizedCoverageRef(id),
      ),
    ),
  ].filter(Boolean);
  return explicitIds.length === 1 ? explicitIds[0] : normalizedId;
}

type RequirementMatchUniqueSignals = {
  bareId: boolean;
  requirementText: boolean;
  tableId: boolean;
  tableService: boolean;
  fullIdentity: boolean;
  coverageIdentity: boolean;
  idService: boolean;
  sourceBinding: boolean;
};

type RequirementMatchSignal = keyof RequirementMatchUniqueSignals;

type RequirementMatchIdentity = {
  rawId: string;
  bareId: string;
  requirementText: string;
  tableId: string;
  service: string;
  tableService: string;
  fullIdentity: string;
  coverageIdentity: string;
  idService: string;
  sourceBinding: string;
  solutionBinding: string;
  synthetic: boolean;
  generated: boolean;
};

type RequirementMatchSignalMaps<T> = Record<
  RequirementMatchSignal,
  Map<string, T>
>;

const REQUIREMENT_MATCH_SIGNALS: RequirementMatchSignal[] = [
  "bareId",
  "requirementText",
  "tableId",
  "tableService",
  "fullIdentity",
  "coverageIdentity",
  "idService",
  "sourceBinding",
];

function buildRequirementMatchIdentity(entry: RequirementLedgerEntry) {
  const bareId = normalizedRequirementMatchId(entry);
  const requirementText = normalizedRequirementMatchText(entry);
  const tableId = normalizedStrongRequirementRowIdentity(entry.tableId);
  const service = normalizeComparableText(entry.service ?? "");
  const fullIdentity = normalizedCoverageRef(requirementFullReference(entry));
  const coverageIdentity = normalizedCoverageRef(
    requirementCoverageRef(entry),
  );

  return {
    rawId: normalizedCoverageRef(entry.id),
    bareId,
    requirementText,
    tableId,
    service,
    tableService: tableId && service ? `${tableId}::${service}` : "",
    fullIdentity:
      fullIdentity && fullIdentity !== bareId ? fullIdentity : "",
    coverageIdentity:
      coverageIdentity && coverageIdentity !== bareId ? coverageIdentity : "",
    idService: bareId && service ? `${bareId}::${service}` : "",
    sourceBinding: normalizedSourceLedgerBinding(entry),
    solutionBinding: normalizedSolutionSourceBinding(entry),
    synthetic: isSyntheticRequirementId(entry.id),
    generated: isGeneratedRequirementId(entry.id),
  } satisfies RequirementMatchIdentity;
}

function requirementMatchSignalValue(
  identity: RequirementMatchIdentity,
  signal: RequirementMatchSignal,
  side: "source" | "solution",
) {
  if (signal === "sourceBinding") {
    return side === "source"
      ? identity.sourceBinding
      : identity.solutionBinding;
  }
  return identity[signal];
}

function emptyRequirementMatchSignalMaps<T>() {
  return Object.fromEntries(
    REQUIREMENT_MATCH_SIGNALS.map((signal) => [signal, new Map<string, T>()]),
  ) as RequirementMatchSignalMaps<T>;
}

function buildRequirementMatchSignalCounts(
  identities: RequirementMatchIdentity[],
  side: "source" | "solution",
) {
  const counts = emptyRequirementMatchSignalMaps<number>();
  for (const identity of identities) {
    for (const signal of REQUIREMENT_MATCH_SIGNALS) {
      const value = requirementMatchSignalValue(identity, signal, side);
      if (!value) continue;
      counts[signal].set(value, (counts[signal].get(value) ?? 0) + 1);
    }
  }
  return counts;
}

function buildRequirementMatchSolutionIndexes(
  identities: RequirementMatchIdentity[],
) {
  const indexes = emptyRequirementMatchSignalMaps<number>();
  identities.forEach((identity, index) => {
    for (const signal of REQUIREMENT_MATCH_SIGNALS) {
      const value = requirementMatchSignalValue(identity, signal, "solution");
      if (value && !indexes[signal].has(value)) {
        indexes[signal].set(value, index);
      }
    }
  });
  return indexes;
}

function requirementSolutionMatchScore(input: {
  source: RequirementMatchIdentity;
  candidate: RequirementMatchIdentity;
  uniqueSignals: RequirementMatchUniqueSignals;
}) {
  if (
    input.source.bareId !== input.candidate.bareId &&
    /\d/.test(input.source.bareId) &&
    /\d/.test(input.candidate.bareId) &&
    !input.source.generated &&
    !input.candidate.generated
  ) {
    return 0;
  }
  if (
    (input.source.synthetic || input.candidate.synthetic) &&
    input.source.rawId !== input.candidate.rawId
  ) {
    return 0;
  }

  const sourceTableId = input.source.tableId;
  const candidateTableId = input.candidate.tableId;
  if (
    sourceTableId &&
    candidateTableId &&
    sourceTableId !== candidateTableId
  ) {
    return 0;
  }

  const sourceText = input.source.requirementText;
  const candidateText = input.candidate.requirementText;
  const hasSyntheticReference =
    input.source.synthetic || input.candidate.synthetic;
  const exactNormalizedRequirementText =
    Boolean(sourceText) && sourceText === candidateText;
  const exactRequirementText =
    sourceText.length >= 20 && exactNormalizedRequirementText;
  const sourceBinding = input.source.sourceBinding;
  const candidateSourceBinding = input.candidate.solutionBinding;
  if (hasSyntheticReference && !exactNormalizedRequirementText) {
    return 0;
  }
  if (
    hasSyntheticReference &&
    (!candidateSourceBinding || sourceBinding !== candidateSourceBinding)
  ) {
    return 0;
  }
  const exactSourceBinding =
    Boolean(sourceBinding) && sourceBinding === candidateSourceBinding;
  const sourceService = input.source.service;
  const candidateService = input.candidate.service;
  const exactService =
    Boolean(sourceService) && sourceService === candidateService;
  const exactTableId =
    Boolean(sourceTableId) && sourceTableId === candidateTableId;
  const exactTableService = exactTableId && exactService;
  const sourceId = input.source.bareId;
  const candidateId = input.candidate.bareId;
  const sourceFullIdentity = input.source.fullIdentity;
  const candidateFullIdentity = input.candidate.fullIdentity;
  const exactFullIdentity =
    Boolean(sourceFullIdentity) &&
    sourceFullIdentity === candidateFullIdentity;
  const sourceCoverageIdentity = input.source.coverageIdentity;
  const candidateCoverageIdentity = input.candidate.coverageIdentity;
  const exactCoverageIdentity =
    Boolean(sourceCoverageIdentity) &&
    sourceCoverageIdentity === candidateCoverageIdentity;
  const exactId = sourceId === candidateId;

  let score = 0;
  if (
    exactRequirementText &&
    exactSourceBinding &&
    input.uniqueSignals.sourceBinding
  ) {
    score += 160;
  }
  if (exactRequirementText && input.uniqueSignals.requirementText) score += 100;
  if (exactTableService && input.uniqueSignals.tableService) score += 90;
  else if (exactTableId && input.uniqueSignals.tableId) score += 70;
  if (exactFullIdentity && input.uniqueSignals.fullIdentity) score += 80;
  if (exactCoverageIdentity && input.uniqueSignals.coverageIdentity) score += 60;
  if (exactId && exactService && input.uniqueSignals.idService) score += 50;
  if (!score && exactId && input.uniqueSignals.bareId) score = 10;
  return score;
}

function matchSolutionRequirementEntry(input: {
  sourceIdentity: RequirementMatchIdentity;
  solutionEntries: RequirementLedgerEntry[];
  solutionIdentities: RequirementMatchIdentity[];
  sourceSignalCounts: RequirementMatchSignalMaps<number>;
  solutionSignalCounts: RequirementMatchSignalMaps<number>;
  solutionSignalIndexes: RequirementMatchSignalMaps<number>;
  usedIndexes: Set<number>;
}) {
  const signalIsUnique = (signal: RequirementMatchSignal) => {
    const sourceValue = requirementMatchSignalValue(
      input.sourceIdentity,
      signal,
      "source",
    );
    return (
      Boolean(sourceValue) &&
      input.sourceSignalCounts[signal].get(sourceValue) === 1 &&
      input.solutionSignalCounts[signal].get(sourceValue) === 1
    );
  };
  const uniqueSignals = {
    bareId: signalIsUnique("bareId"),
    requirementText: signalIsUnique("requirementText"),
    tableId: signalIsUnique("tableId"),
    tableService: signalIsUnique("tableService"),
    fullIdentity: signalIsUnique("fullIdentity"),
    coverageIdentity: signalIsUnique("coverageIdentity"),
    idService: signalIsUnique("idService"),
    sourceBinding: signalIsUnique("sourceBinding"),
  } satisfies RequirementMatchUniqueSignals;
  const candidateIndexes = new Set<number>();
  for (const signal of REQUIREMENT_MATCH_SIGNALS) {
    if (!uniqueSignals[signal]) continue;
    const sourceValue = requirementMatchSignalValue(
      input.sourceIdentity,
      signal,
      "source",
    );
    const candidateIndex = input.solutionSignalIndexes[signal].get(sourceValue);
    if (candidateIndex !== undefined) {
      candidateIndexes.add(candidateIndex);
    }
  }

  let bestIndex = -1;
  let bestScore = 0;
  let bestScoreTied = false;
  for (const index of candidateIndexes) {
    if (input.usedIndexes.has(index)) continue;
    const candidateIdentity = input.solutionIdentities[index];
    if (!candidateIdentity) continue;
    const score = requirementSolutionMatchScore({
      source: input.sourceIdentity,
      candidate: candidateIdentity,
      uniqueSignals,
    });
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
      bestScoreTied = false;
    } else if (score > 0 && score === bestScore) {
      bestScoreTied = true;
    }
  }
  if (bestIndex < 0 || bestScoreTied) {
    return null;
  }

  input.usedIndexes.add(bestIndex);
  return input.solutionEntries[bestIndex] ?? null;
}

export function mergeRequirementCoverageLedgerWithSolutionAnswers(input: {
  sourceRequirements: RequirementLedgerEntry[];
  solutionEntries: RequirementLedgerEntry[];
}) {
  const usedSolutionIndexes = new Set<number>();
  const sourceIdentities = input.sourceRequirements.map(
    buildRequirementMatchIdentity,
  );
  const solutionIdentities = input.solutionEntries.map(
    buildRequirementMatchIdentity,
  );
  const sourceSignalCounts = buildRequirementMatchSignalCounts(
    sourceIdentities,
    "source",
  );
  const solutionSignalCounts = buildRequirementMatchSignalCounts(
    solutionIdentities,
    "solution",
  );
  const solutionSignalIndexes = buildRequirementMatchSolutionIndexes(
    solutionIdentities,
  );

  return input.sourceRequirements.map((source, sourceIndex) => {
    const sourceIdentity = sourceIdentities[sourceIndex];
    if (!sourceIdentity) {
      return {
        ...source,
        sourceExcerpt: compactText(
          `Kravgrunnlag: ${source.sourceExcerpt || source.text}`,
          1400,
        ),
        answerExcerpt: "",
      };
    }
    const solution = matchSolutionRequirementEntry({
      sourceIdentity,
      solutionEntries: input.solutionEntries,
      solutionIdentities,
      sourceSignalCounts,
      solutionSignalCounts,
      solutionSignalIndexes,
      usedIndexes: usedSolutionIndexes,
    });

    if (!solution) {
      return {
        ...source,
        sourceExcerpt: compactText(
          `Kravgrunnlag: ${source.sourceExcerpt || source.text}`,
          1400,
        ),
        answerExcerpt: "",
      };
    }

    const answerExcerpt = substantiveRequirementAnswerExcerpt(solution);
    if (!answerExcerpt) {
      return {
        ...source,
        sourceExcerpt: compactText(
          `Kravgrunnlag: ${source.sourceExcerpt || source.text}`,
          1400,
        ),
        answerExcerpt: "",
      };
    }
    return {
      ...source,
      sourceExcerpt: compactText(
        [
          source.sourceExcerpt ? `Kravgrunnlag: ${source.sourceExcerpt}` : "",
          solution.sourceExcerpt ? `Svarrad: ${solution.sourceExcerpt}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        1800,
      ),
      answerExcerpt,
      answerEvidenceExcerpt: solution.answerEvidenceExcerpt,
      answerDocumentId: solution.documentId,
      answerDocumentTitle: solution.documentTitle,
      answerReference:
        solution.answerReference || requirementLedgerSource(solution),
    };
  });
}

function isWeakNarrativeCoverageRequirement(entry: RequirementLedgerEntry) {
  const text = normalizePageText(entry.text);
  return (
    !hasRequirementSignal(text) &&
    !hasStandaloneRequirementLanguage(text) &&
    !detectExplicitRequirementIds(text).length &&
    /^[a-zæøå]/.test(text)
  );
}

export function assertRequirementCoverageBatchesSucceeded(
  failedBatches: Array<{ startIndex: number; count: number; reason: string }>,
  totalBatches: number,
) {
  if (!failedBatches.length) return;
  const failedRequirements = failedBatches.reduce(
    (sum, batch) => sum + batch.count,
    0,
  );
  // The batch reasons stay in the logs; users get counts they can act on.
  throw new WorkflowIncompleteError(
    `Løsningsvurderingen stoppet fordi ${failedBatches.length} av ${totalBatches} AI-batcher (${failedRequirements} krav) ikke ble fullført, heller ikke etter nytt forsøk. Ingen delvis vurdering er lagret. Prøv igjen om litt.`,
  );
}

/**
 * Retries failed coverage batches once each with bounded concurrency. Results
 * keep input order. A lost lease or cancellation aborts instead of being
 * recorded as an ordinary batch failure.
 */
export async function retryRequirementCoverageBatches<TBatch, TValue>(
  batches: TBatch[],
  retry: (batch: TBatch) => Promise<TValue>,
  options: { concurrency: number; assertActive?: () => void },
) {
  const assertActive = options.assertActive ?? (() => {});
  return mapWithConcurrency(batches, Math.max(1, options.concurrency), async (batch) => {
    try {
      return { batch, ok: true as const, value: await retry(batch) };
    } catch (error) {
      assertActive();
      return { batch, ok: false as const, error };
    }
  });
}

export function selectRequirementsForSolutionCoverage(input: {
  ledger: RequirementLedgerEntry[];
  hasExplicitSourceLedger: boolean;
}) {
  if (input.hasExplicitSourceLedger) {
    const normalizedLedger = input.ledger.map((entry) => {
      const normalized = normalizeCoverageRequirementEntry(entry);
      return normalized.text.trim()
        ? normalized
        : { ...normalized, text: entry.text.trim() };
    });
    const emptyEntries = normalizedLedger.filter((entry) => !entry.text.trim());
    if (emptyEntries.length) {
      throw new Error(
        `Kravvurderingen stoppet fordi eksplisitt kravgrunnlag inneholder ${emptyEntries.length} rad(er) uten kravtekst: ${emptyEntries
          .slice(0, 5)
          .map((entry) => entry.id)
          .join(", ")}. Kilden må korrigeres eller ekstraheres på nytt før fullstendig dekning kan bekreftes.`,
      );
    }
    // Explicit source ledgers are already deduplicated during extraction and
    // are authoritative here. Preserve every source unit so equal IDs/text on
    // different rows or sections cannot disappear before fail-closed coverage
    // integrity validation.
    return normalizedLedger;
  }

  return dedupeRequirementLedger(
    filterSyntheticRequirementFallbacks(input.ledger).map(
      normalizeCoverageRequirementEntry,
    ),
  ).filter(
    (entry) =>
      entry.text.replace(/\s+/g, " ").trim().length >= 20 &&
      !isLikelyDetailOrAnswerBlock(entry.text) &&
      !isWeakNarrativeCoverageRequirement(entry),
  );
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

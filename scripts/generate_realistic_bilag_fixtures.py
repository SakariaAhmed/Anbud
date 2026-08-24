from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    LongTable,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPOSITORY_ROOT / "output" / "pdf" / "realistic-bilag"

PAGE_WIDTH, PAGE_HEIGHT = A4
NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#245B78")
TEAL = colors.HexColor("#1C7C7D")
PALE_BLUE = colors.HexColor("#EAF2F7")
PALE_TEAL = colors.HexColor("#E8F5F3")
PALE_GREY = colors.HexColor("#F4F6F8")
MID_GREY = colors.HexColor("#687784")
DARK = colors.HexColor("#1C2833")
WHITE = colors.white


@dataclass(frozen=True)
class Requirement:
    requirement_id: str
    category: str
    topic: str
    requirement: str
    answer_instruction: str
    supplier_status: str
    supplier_answer: str


REQUIREMENTS = [
    Requirement(
        "FUN-A01",
        "A",
        "Saksbehandling",
        "Tjenesten skal støtte mottak, fordeling, behandling, vedtak og avslutning av byggesaker i én sammenhengende arbeidsflate. Alle statusendringer skal tidsstemples og knyttes til ansvarlig rolle.",
        "Bekreft oppfyllelse og beskriv kort hvordan arbeidsflyt og historikk ivaretas.",
        "Oppfylt",
        "Saksløft leverer én rollebasert arbeidsflate fra mottak til avslutning. Hver overgang lagres med tidspunkt, bruker, tidligere status og ny status. Fagansvarlig kan konfigurere arbeidsflyter uten kode, mens endringer i produksjonsoppsettet krever totrinnsgodkjenning.",
    ),
    Requirement(
        "FUN-A02",
        "A",
        "Innbyggerdialog",
        "Eksterne brukere skal autentiseres med ID-porten. Tjenesten skal vise egne søknader, dokumenter, frister og saksstatus uten at brukeren får innsyn i andre saker.",
        "Bekreft oppfyllelse og angi autentiserings- og tilgangsmekanisme.",
        "Oppfylt",
        "Innbyggerportalen bruker ID-porten via OpenID Connect. Tilgang opprettes først når fødselsnummer eller organisasjonsnummer er koblet til en partsrolle i den aktuelle saken. Autorisasjon kontrolleres ved hvert kall, og direkte dokumentlenker kan ikke gjenbrukes uten en aktiv, gyldig sesjon.",
    ),
    Requirement(
        "FUN-B01",
        "B",
        "Innbyggerdialog",
        "Leverandøren skal følge fremgangsmåten beskrevet i Bilag 2 for å gi søker og ansvarlig foretak forståelig status, neste forventede aktivitet og varsling ved manglende dokumentasjon.",
        "Beskriv brukerreisen, varslingskanaler og hvordan kommunen kan endre tekster og regler.",
        "Oppfylt",
        "Portalen viser status i klart språk, ansvarlig enhet og neste forventede hendelse. Varsling kan sendes via e-post, SMS eller Altinn når kommunen har valgt kanal. Superbruker kan redigere meldingstekster og fristregler i et versjonert administrasjonsgrensesnitt. Utsendelser logges på saken.",
    ),
    Requirement(
        "FUN-B02",
        "B",
        "Datakvalitet",
        "Tjenesten skal gi kontekstavhengig veiledning og kontrollere obligatoriske opplysninger før innsending, slik at andelen mangelfulle søknader reduseres.",
        "Beskriv validering, veiledning og hvordan effekten kan måles.",
        "Oppfylt",
        "Skjemaet tilpasser spørsmål etter tiltakstype og tidligere svar. Obligatoriske felt, vedlegg og enkle krysskontroller valideres før innsending. Kommunen får en månedlig rapport over stoppede feil, ettersendt dokumentasjon og saker som fortsatt må kompletteres. Referanseverdien fastsettes i pilotfasen.",
    ),
    Requirement(
        "DOK-A03",
        "A",
        "Dokument og journal",
        "Alle inn- og utgående saksdokumenter skal kunne journalføres med fullstendige metadata og overføres til kommunens Noark 5-godkjente arkivkjerne uten manuell dobbeltregistrering.",
        "Bekreft oppfyllelse og beskriv integrasjon, feilhåndtering og sporbarhet.",
        "Oppfylt",
        "Dokument og metadata sendes til arkivkjernen gjennom en versjonert integrasjon. Kvittering lagres på saken. Feil plasseres i en egen arbeidskø med årsak, teknisk korrelasjons-ID og forslag til retting. Ny sending kan utføres uten at dokumentet journalføres to ganger.",
    ),
    Requirement(
        "IAM-A04",
        "A",
        "Identitet og roller",
        "Ansatte skal autentiseres med kommunens Microsoft Entra ID. Tilgang skal styres etter minste privilegium og kunne avgrenses etter enhet, rolle, sakstype og skjermingsbehov.",
        "Bekreft oppfyllelse og angi støttede standarder og kontrollnivåer.",
        "Oppfylt",
        "Ansatte bruker kommunens Entra ID med OpenID Connect og kommunens egne krav til flerfaktorautentisering og betinget tilgang. Grupper kan synkroniseres med SCIM. Roller kan avgrenses etter organisatorisk enhet, sakstype og skjermingskode. Kvartalsvis tilgangsrapport inngår.",
    ),
    Requirement(
        "INT-A05",
        "A",
        "Nasjonale fellesløsninger",
        "Tjenesten skal kunne integreres med ID-porten, Matrikkelen, Folkeregisteret og én meldingskanal valgt av Kunden: Altinn eller KS Fiks/SvarUt.",
        "Bekreft oppfyllelse. Skill standardkoblinger fra konfigurasjon eller tilpasning.",
        "Oppfylt",
        "ID-porten, Matrikkelen og Folkeregisteret leveres som standardkoblinger. Altinn og KS Fiks/SvarUt støttes begge, men Nordhavn velger én kanal for første produksjonssetting. Oppsett av sertifikater, tilganger, meldingsprofiler og testmiljø inngår i etableringen.",
    ),
    Requirement(
        "INT-B03",
        "B",
        "Integrasjoner",
        "Leverandøren skal beskrive hvordan åpne, dokumenterte grensesnitt og hendelser kan brukes av kommunens dataplattform og fremtidige fagsystemer uten leverandørspesifikk låsing.",
        "Beskriv API-er, hendelser, versjonering, begrensninger og dokumentasjon.",
        "Oppfylt",
        "Saksløft tilbyr REST-API dokumentert med OpenAPI 3.1 og webhooks for opprettelse, statusendring, dokumentmottak og vedtak. Versjoner støttes parallelt i minst 18 måneder. Standardgrensen er 300 kall per minutt per integrasjonsklient; høyere volum dimensjoneres etter måling i etableringsfasen.",
    ),
    Requirement(
        "MIG-A06",
        "A",
        "Datamigrering",
        "Leverandøren skal migrere om lag 220 000 saker, 1,15 millioner dokumentfiler og tilhørende metadata fra 2008 og fremover. Ingen journalførte dokumenter eller rettighetsmarkeringer skal gå tapt.",
        "Bekreft oppfyllelse og beskriv hvordan fullstendighet dokumenteres.",
        "Oppfylt",
        "Leverandøren gjennomfører profilering, prøvemigrering og to komplette testmigreringer før produksjonsflytting. Antall saker og filer, kontrollsummer for filer, metadatafelter, partsroller og skjermingskoder avstemmes mot kildeuttrekket. Avvik dokumenteres per feilkategori og må lukkes eller godkjennes av Nordhavn før produksjonssetting.",
    ),
    Requirement(
        "MIG-B04",
        "B",
        "Overgang",
        "Leverandøren skal følge en trinnvis migrerings- og innføringsmetode som begrenser driftsavbrudd og gjør det mulig å verifisere de mest risikoutsatte sakstypene tidlig.",
        "Beskriv faser, testutvalg, tilbakefallsplan og kommunens medvirkning.",
        "Oppfylt",
        "Et representativt testutvalg etableres for delingssaker, dispensasjoner, saker med skjerming og saker med mange dokumentversjoner. Pilot gjennomføres med Plan og byggesak før de øvrige enhetene. Produksjonssetting skjer over en helg med lesetilgang til gammel løsning. Tilbakefall besluttes dersom avstemmingen viser kritiske avvik.",
    ),
    Requirement(
        "SIK-A07",
        "A",
        "Datalokasjon",
        "Kundedata, sikkerhetskopier og driftslogger som kan inneholde personopplysninger, skal behandles innenfor EØS. Leverandøren skal føre oppdatert oversikt over underleverandører og behandlingssteder.",
        "Bekreft oppfyllelse og oppgi behandlingsregioner og underleverandørstyring.",
        "Oppfylt",
        "Kundedata og sikkerhetskopier lagres i Microsoft Azure i Norge. Sekundær beredskapskopi og personidentifiserbar applikasjonslogg forblir i Norge. Driftstelemetri uten saksinnhold behandles i Sverige. Alle behandlingssteder ligger i EØS og fremgår av underleverandørlisten. Endringer varsles 60 dager før ikrafttredelse.",
    ),
    Requirement(
        "SIK-A08",
        "A",
        "Informasjonssikkerhet",
        "Tjenesten skal kryptere data under overføring og lagring, logge administrative handlinger og støtte eksport av sikkerhetshendelser til Kundens sikkerhetsovervåking. Kritiske sårbarheter skal håndteres etter dokumenterte frister.",
        "Bekreft oppfyllelse og beskriv kontroller, logger og sårbarhetshåndtering.",
        "Oppfylt",
        "Trafikk krypteres med TLS 1.2 eller nyere, og data lagres kryptert med plattformstyrte nøkler. Administrative handlinger, tilgang til skjermede saker og endringer i roller logges. Hendelser kan sendes til kommunens sikkerhetsovervåking i CEF- eller JSON-format. Kritiske sårbarheter risikovurderes innen fire timer og får korrigerende tiltak innen 72 timer.",
    ),
    Requirement(
        "SIK-B05",
        "B",
        "Styringsinformasjon",
        "Kunden skal kunne følge saksbehandlingstid, restanser, kompletteringsbehov, integrasjonsfeil og tilgangsavvik uten at Leverandøren må utvikle nye rapporter for hver måling.",
        "Beskriv standardrapporter, filtrering, eksport og tilgangsstyring.",
        "Oppfylt",
        "Standardpakken inneholder dashbord for saksalder, fristbrudd, restanser, kompletteringer, integrasjonskø og tilgangskontroll. Data kan filtreres på enhet, sakstype og periode, og eksporteres som CSV eller hentes gjennom rapport-API. Hvert dashbord følger samme rollemodell som saksdataene.",
    ),
    Requirement(
        "UU-A09",
        "A",
        "Universell utforming",
        "Innbyggerrettede flater skal oppfylle WCAG 2.2 nivå AA. Leverandøren skal dokumentere testresultater og rette kritiske tilgjengelighetsfeil før produksjonssetting.",
        "Bekreft oppfyllelse og beskriv test- og rettingsprosessen.",
        "Oppfylt",
        "Portalen er utviklet mot WCAG 2.2 nivå AA. Før produksjonssetting utføres automatiserte tester, tastaturnavigasjon, skjermlesertest og manuell kontroll av de avtalte brukerreisene. Kritiske feil blokkerer godkjenning. Testrapport og avvikslogg leveres til Nordhavn.",
    ),
    Requirement(
        "DRI-A10",
        "A",
        "Tilgjengelighet",
        "Tjenesten skal ha månedlig tilgjengelighet på minst 99,9 prosent, eksklusive varslet vedlikehold innenfor avtalt vedlikeholdsvindu. RPO skal være høyst 4 timer og RTO høyst 8 timer.",
        "Bekreft oppfyllelse og oppgi tilbudt nivå og målepunkt.",
        "Oppfylt",
        "Tilbudt tilgjengelighet er 99,95 prosent per kalendermåned, målt ved innlogget syntetisk transaksjon i både saksbehandlerflate og innbyggerportal. Tilbudt RPO er 1 time og RTO er 4 timer. Resultatene rapporteres månedlig sammen med hendelser og kompenserende tiltak.",
    ),
    Requirement(
        "DRI-B06",
        "B",
        "Driftsinnsikt",
        "Leverandøren skal beskrive proaktiv overvåking, hendelseshåndtering, varsling og hvordan gjentakende feil blir fulgt opp.",
        "Beskriv målepunkt, responstider, rotårsaksanalyse og forbedringssløyfe.",
        "Oppfylt",
        "Overvåkingen dekker brukerreiser, API-er, meldingskøer, arkivoverføring og databasetjenester. Kritiske hendelser varsles til Nordhavns beredskapskontakt innen 15 minutter. Foreløpig status gis hvert 30. minutt. Rotårsaksanalyse leveres innen fem arbeidsdager for alvorlige eller gjentakende hendelser.",
    ),
    Requirement(
        "OPL-B07",
        "B",
        "Opplæring og innføring",
        "Leverandøren skal beskrive et rollebasert opplæringsopplegg for 127 ansatte, herunder saksbehandlere, ledere, superbrukere, arkivpersonell og tjenesteforvalter.",
        "Beskriv format, omfang, materiell, evaluering og støtte etter produksjonssetting.",
        "Oppfylt",
        "Opplæringen kombinerer digitale forkurs, scenarioverksteder og øving i testmiljø. Femten superbrukere får to hele dager, mens øvrige roller får målrettede økter på to til fire timer. Materiell leveres på norsk og oppdateres ved endringer. Digitale spørretimer tilbys ukentlig de første seks ukene.",
    ),
    Requirement(
        "DATA-A11",
        "A",
        "Data og avslutning",
        "Kunden skal på forespørsel og ved avtalens opphør kunne hente ut saksdata, dokumenter, metadata, tilgangsmarkeringer og revisjonslogger i dokumenterte, maskinlesbare formater.",
        "Bekreft oppfyllelse og beskriv formater, frister og verifikasjon.",
        "Oppfylt",
        "Data leveres som JSON eller CSV for strukturert informasjon og i originalt filformat for dokumenter. Manifestet knytter filer til sak, journalpost, versjon og tilgangsmarkering. Et komplett prøveuttrekk kan bestilles årlig uten tillegg i abonnementsprisen. Endelig uttrekk leveres senest 30 kalenderdager etter avtalt skjæringsdato.",
    ),
]


BILAG_1_SECTIONS = [
    (
        "1. Formål og anskaffelsesramme",
        [
            "Nordhavn kommune skal anskaffe en standardisert programvaretjeneste for byggesaksbehandling, dokumentflyt og digital dialog med innbyggere og ansvarlige foretak. Tjenesten skal leveres som SaaS under SSA-L 2026. Bilag 1 beskriver Kundens behov og krav. Leverandørens bindende beskrivelse av tjenesten skal stå i Bilag 2.",
            "Kunden har 38 400 innbyggere og 127 ansatte som skal bruke tjenesten på tvers av Plan og byggesak, Eiendom, Oppmåling, Dokumentsenteret og Innbyggertorget. Kommunen behandler om lag 3 200 byggesaker årlig. Eksisterende avtale utløper 30. juni 2027, og ny tjeneste skal være i ordinær drift senest 1. april 2027.",
            "Dokumentet er et fiktivt, men realistisk testdokument. Navn, tall og tilbud er laget for kvalitetssikring av dokumentanalyse og skal ikke brukes som juridisk mal eller som grunnlag for en reell konkurranse.",
        ],
    ),
    (
        "2. Dagens situasjon og kjøpsdriver",
        [
            "Dagens arbeidsflyt er fordelt på et eldre fagsystem, en separat innbyggerportal, kommunens Noark 5-godkjente arkivkjerne og manuelle oversikter i e-post og regneark. Saksbehandlere registrerer de samme opplysningene flere steder, mens innbyggere ofte må kontakte Innbyggertorget for å forstå status eller ettersende dokumentasjon.",
            "En intern måling fra andre kvartal 2026 viser at 28 prosent av henvendelsene til Innbyggertorget gjelder saksstatus. Omtrent 18 prosent av nye søknader må kompletteres før ordinær behandling kan starte. Tallene er Kundens referanseverdier for gevinstoppfølging, ikke garanterte effekter av ny tjeneste.",
            "Kommunen skal migrere om lag 220 000 saker, 1,15 millioner dokumentfiler og tilhørende metadata fra 2008 og fremover. Datagrunnlaget inneholder flere historiske kodeverk, skjermede saker og dokumentversjoner. Migrering, rettighetsmarkering og avstemming er derfor en sentral leveranserisiko.",
        ],
    ),
    (
        "3. Mål og målbare utfall",
        [
            "Innen seks måneder etter produksjonssetting skal manuell dobbeltregistrering mellom fagsystem og arkiv være redusert med minst 40 prosent sammenlignet med referanseverdien fra andre kvartal 2026.",
            "Innen tolv måneder skal minst 85 prosent av søkerne kunne finne saksstatus og neste forventede aktivitet uten å kontakte Innbyggertorget. Andelen nye søknader som må kompletteres, skal reduseres fra 18 til 10 prosent eller lavere.",
            "Kommunen skal kunne følge saksalder, restanser, kompletteringsbehov, integrasjonsfeil og tilgangsavvik fra samme styringsflate. Måloppnåelse skal kunne dokumenteres per enhet og sakstype uten manuell sammenstilling i regneark.",
        ],
    ),
    (
        "4. Omfang og avgrensning",
        [
            "Leveransen omfatter abonnement, konfigurering, integrasjoner, migrering, test, rollebasert opplæring, produksjonssetting, brukerstøtte, vedlikehold og løpende sikkerhetsoppfølging. Leverandøren har helhetlig ansvar for egen tjeneste og egne integrasjonskomponenter.",
            "Kommunen beholder ansvar for faglige vedtak, behandlingsgrunnlag, tilgang til nasjonale fellesløsninger, intern endringsledelse og kvaliteten i kildedata utover avtalte renseaktiviteter.",
            "Anskaffelsen omfatter ikke utskifting av kommunens arkivkjerne, generell dataplattform, økonomisystem eller sikkerhetsovervåking. Eventuell integrasjon mot eByggesak-sjekklister utover grensesnittene i kravtabellen er en opsjon som må prises separat.",
        ],
    ),
    (
        "5. Kravtyper og besvarelse",
        [
            "A-krav er absolutte minimumskrav. Leverandøren skal bekrefte oppfyllelse og gi etterspurt dokumentasjon. Manglende oppfyllelse kan medføre avvisning. A-krav evalueres ikke utover kontroll av oppfyllelse.",
            "B-krav er evalueringskrav. Leverandøren skal beskrive hvordan kravet oppfylles i Bilag 2. Besvarelsene vurderes under tildelingskriteriene kvalitet eller gjennomføring. Kundens kravtekst og krav-ID skal ikke endres i Bilag 2.",
            "Henvisning til standard produktdokumentasjon er tillatt som tillegg, men Bilag 2 skal inneholde hovedsvaret. Leverandøren skal tydelig oppgi forutsetninger, avgrensninger og avvik ved den enkelte krav-ID.",
        ],
    ),
    (
        "7. Gjennomføring og milepæler",
        [
            "Kontraktsignering er planlagt 15. oktober 2026. Kartlegging og dataprofilering skal være ferdig 30. november 2026. Første komplette testmigrering skal være ferdig 22. januar 2027, pilot skal starte 15. februar 2027, og ordinær drift skal starte senest 1. april 2027.",
            "Kunden planlegger en kontrollert parallellperiode frem til 30. april 2027. Eksisterende løsning skal deretter være tilgjengelig i lesemodus frem til avtalen utløper 30. juni 2027.",
            "Leverandørens fremdriftsplan skal vise avhengigheter, Kundens medvirkning, beslutningspunkter, testansvar, tilbakefallsplan og bemanning i perioden fra testmigrering til ordinær drift.",
        ],
    ),
    (
        "8. Tildelingskriterier",
        [
            "Kvalitet i tilbudt tjeneste vektes 45 prosent. Vurderingen bygger særlig på FUN-B01, FUN-B02, INT-B03, SIK-B05 og DRI-B06.",
            "Gjennomføring og overgang vektes 30 prosent. Vurderingen bygger særlig på MIG-B04, OPL-B07, realismen i fremdriftsplanen og håndtering av avhengigheter.",
            "Pris vektes 25 prosent. Prisen vurderes fra samlet estimert kontraktsverdi for fire år, inkludert etablering, abonnement, avtalte integrasjoner og opsjoner som fremgår av prisskjemaet.",
        ],
    ),
    (
        "9. Åpne avklaringer før endelig tilbud",
        [
            "Kunden avklarer med dagens leverandør om historiske dokumentversjoner kan leveres med stabile identifikatorer og kontrollsummer. Endelig uttrekksformat blir publisert senest 28. august 2026.",
            "Kunden velger Altinn eller KS Fiks/SvarUt som første meldingskanal etter en teknisk verifikasjon. Leverandøren skal prise standardkoblingen likt for begge alternativer.",
            "Omfanget av saker med særskilt skjerming er foreløpig estimert til 3 500. Eksakt antall og kodeverk bekreftes etter dataprofilering.",
            "Kunden har ikke fastsatt endelig grense for hvor mange eksterne konsulentselskaper som skal ha delegert tilgang. Tilbudet skal forklare lisens- og sikkerhetskonsekvensen av 50, 100 og 200 eksterne brukere.",
        ],
    ),
]


BILAG_2_SECTIONS = [
    (
        "1. Leverandørens beskrivelse av tjenesten",
        [
            "KystSky AS tilbyr Saksløft Cloud 4.2 som standardisert SaaS-tjeneste. Tjenesten samler saksbehandling, innbyggerdialog, dokumentflyt, integrasjoner og styringsinformasjon i én forvaltet plattform. Tilbudet omfatter abonnement, konfigurering, migrering, integrasjoner, opplæring og løpende tjenesteforvaltning.",
            "Produksjonsmiljøet etableres i Microsoft Azure i Norge med separate miljøer for test og produksjon. Identitet kobles til Nordhavn kommunes Microsoft Entra ID for ansatte og ID-porten for eksterne brukere. Nasjonale fellesløsninger og arkivkjernen kobles gjennom versjonerte integrasjoner.",
            "KystSky tar ansvar for egen tjeneste, integrasjonskomponenter og underleverandører. Nordhavn beholder ansvar for faglige beslutninger, bestilling og tilgang til nasjonale grensesnitt, kvaliteten i kildedata utover avtalt datarens og lokal endringsledelse.",
        ],
    ),
    (
        "2. Forutsetninger og avklaringer",
        [
            "Tilbudet inneholder ingen avvik fra A-kravene. Planen forutsetter at dagens leverandør leverer første komplette kildeuttrekk senest 5. oktober 2026 og at Nordhavn stiller med beslutningsdyktige fagrepresentanter i ukentlige arbeidsmøter fra kontraktsignering til pilot.",
            "Nordhavn må velge Altinn eller KS Fiks/SvarUt som første meldingskanal innen 1. desember 2026. Den andre kanalen kan innføres senere som endring eller opsjon uten at datamodellen må bygges om.",
            "Standardgrensen for API-trafikk er 300 kall per minutt per integrasjonsklient. Dersom kommunens dataplattform krever høyere varig volum, dimensjoneres og prises dette etter måling i etableringsfasen.",
        ],
    ),
    (
        "4. Gjennomføringsplan",
        [
            "15. oktober til 30. november 2026: etablering av styring, løsningsdesign, dataprofilering, integrasjonsavklaringer og referanseverdier for gevinstmåling. Leveranser er beslutningslogg, datakvalitetsrapport og godkjent detaljplan.",
            "1. desember 2026 til 22. januar 2027: konfigurasjon, integrasjoner, første komplette testmigrering og teknisk sikkerhetstest. Kritiske migreringsavvik skal være kategorisert og ha avtalt eier før fasen godkjennes.",
            "23. januar til 14. februar 2027: andre testmigrering, test av hele kjeden for prioriterte brukerreiser, opplæring av superbrukere og beredskapsøvelse. Pilotbeslutningen tas av styringsgruppen på dokumentert testgrunnlag.",
            "15. februar til 31. mars 2027: pilot i Plan og byggesak, opplæring av øvrige brukergrupper og produksjonsforberedelse. Produksjonssetting planlegges helgen 27. til 28. mars, med ordinær drift fra 1. april 2027.",
            "1. april til 12. mai 2027: seks ukers forsterket oppfølging med daglig prioriteringsmøte den første uken, ukentlig gevinstmåling og digitale spørretimer. Overgang til ordinær forvaltning skjer når åpne feil og avvik er innenfor godkjente terskler.",
        ],
    ),
    (
        "5. Sikkerhet, personvern og data",
        [
            "Saksløft benytter rollebasert tilgang, separat administrasjonstilgang, kryptering under overføring og lagring, og uforanderlig sikkerhetslogg for privilegerte handlinger. Kundedata behandles innenfor EØS. Behandlingssteder og underleverandører dokumenteres i databehandleravtalen.",
            "KystSky gjennomfører årlig uavhengig penetrasjonstest og løpende sårbarhetsskanning. Kritiske funn risikovurderes innen fire timer. Korrigerende tiltak gjennomføres innen 72 timer. En annen frist kan benyttes dersom Nordhavn skriftlig godkjenner et midlertidig risikoreduserende tiltak.",
            "Nordhavn eier egne data. Årlig prøveuttrekk inngår i abonnementet. Ved avslutning leveres et uttrekk med manifest over saksdata, dokumenter, metadata, rettighetsmarkeringer og revisjonslogger i dokumenterte, maskinlesbare formater.",
        ],
    ),
    (
        "6. Operativ forvaltning",
        [
            "KystSky overvåker innlogging, sentrale brukerreiser, integrasjoner, meldingskøer og databasetjenester hele døgnet. Nordhavns tjenesteforvalter får månedlig rapport om tilgjengelighet, hendelser, kapasitet, sårbarheter, endringer og avtalte gevinstindikatorer.",
            "Endringer varsles gjennom en rullerende 90-dagers plan. Endringer med mulig påvirkning på integrasjoner eller brukerflyt tilbys i testmiljø minst 20 arbeidsdager før produksjonssetting. Kritiske sikkerhetsoppdateringer kan følge kortere løp, men varsles og dokumenteres.",
            "Alvorlige hendelser håndteres av vaktleder, teknisk hendelsesleder og kommunikasjonsansvarlig. Nordhavn mottar første varsel innen 15 minutter, løpende status og rotårsaksanalyse innen fem arbeidsdager.",
        ],
    ),
]


EXPECTED_FACTS = {
    "project_name": "Nordhavn kommune - digital byggesaksbehandling",
    "customer_document": "bilag1_nordhavn_byggesak_2026.pdf",
    "must_cover": [
        {
            "id": "customer_and_scale",
            "signals": ["Nordhavn kommune", "38 400", "127 ansatte", "3 200 byggesaker"],
        },
        {
            "id": "buying_trigger",
            "signals": ["30. juni 2027", "1. april 2027", "eksisterende avtale"],
        },
        {
            "id": "migration_scope",
            "signals": ["220 000 saker", "1,15 millioner", "2008"],
        },
        {
            "id": "baseline_and_outcomes",
            "signals": ["28 prosent", "18 prosent", "40 prosent", "85 prosent", "10 prosent"],
        },
        {
            "id": "evaluation",
            "signals": ["45 prosent", "30 prosent", "25 prosent"],
        },
        {
            "id": "service_levels",
            "signals": ["99,9 prosent", "RPO", "4 timer", "RTO", "8 timer"],
        },
        {
            "id": "technical_context",
            "signals": [
                "ID-porten",
                "Microsoft Entra ID",
                "Matrikkelen",
                "Folkeregisteret",
                "Noark 5",
            ],
        },
        {
            "id": "open_questions",
            "signals": [
                "Altinn",
                "KS Fiks/SvarUt",
                "kontrollsummer",
                "3 500",
                "eksterne brukere",
            ],
        },
    ],
    "forbidden_generic_phrases": [
        "moderne og skalerbar løsning",
        "helhetlig digital transformasjon",
        "beste praksis",
        "sømløs brukeropplevelse",
        "fremtidsrettet plattform",
    ],
}


def register_fonts() -> None:
    regular_candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/Library/Fonts/Arial Unicode.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    bold_candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    regular = next(path for path in regular_candidates if path.exists())
    bold = next(path for path in bold_candidates if path.exists())
    pdfmetrics.registerFont(TTFont("FixtureSans", str(regular)))
    pdfmetrics.registerFont(TTFont("FixtureSans-Bold", str(bold)))


def styles():
    base = getSampleStyleSheet()
    return {
        "cover_title": ParagraphStyle(
            "CoverTitle",
            parent=base["Title"],
            fontName="FixtureSans-Bold",
            fontSize=26,
            leading=31,
            textColor=WHITE,
            alignment=TA_LEFT,
            spaceAfter=8 * mm,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle",
            parent=base["Normal"],
            fontName="FixtureSans",
            fontSize=13,
            leading=19,
            textColor=colors.HexColor("#DDEAF2"),
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="FixtureSans-Bold",
            fontSize=16,
            leading=20,
            textColor=NAVY,
            spaceBefore=5 * mm,
            spaceAfter=3 * mm,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="FixtureSans-Bold",
            fontSize=11.5,
            leading=15,
            textColor=BLUE,
            spaceBefore=3 * mm,
            spaceAfter=2 * mm,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="FixtureSans",
            fontSize=9.3,
            leading=13.4,
            textColor=DARK,
            spaceAfter=2.6 * mm,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName="FixtureSans",
            fontSize=7.7,
            leading=10.2,
            textColor=DARK,
        ),
        "small_bold": ParagraphStyle(
            "SmallBold",
            parent=base["BodyText"],
            fontName="FixtureSans-Bold",
            fontSize=7.7,
            leading=10.2,
            textColor=DARK,
        ),
        "small_header": ParagraphStyle(
            "SmallHeader",
            parent=base["BodyText"],
            fontName="FixtureSans-Bold",
            fontSize=7.7,
            leading=10.2,
            textColor=WHITE,
        ),
        "callout": ParagraphStyle(
            "Callout",
            parent=base["BodyText"],
            fontName="FixtureSans",
            fontSize=9,
            leading=13,
            textColor=NAVY,
            leftIndent=4 * mm,
            rightIndent=4 * mm,
            spaceBefore=2 * mm,
            spaceAfter=2 * mm,
        ),
        "center": ParagraphStyle(
            "Center",
            parent=base["BodyText"],
            fontName="FixtureSans",
            fontSize=8.5,
            leading=11,
            alignment=TA_CENTER,
            textColor=MID_GREY,
        ),
    }


class FixtureDocTemplate(BaseDocTemplate):
    def __init__(self, filename: Path, document_title: str):
        super().__init__(
            str(filename),
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=20 * mm,
            bottomMargin=18 * mm,
            title=document_title,
            author="Bidsite testdokument",
            subject="Realistisk test av norsk kundeanalyse",
        )
        self.document_title = document_title
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="normal",
        )
        self.addPageTemplates(
            [
                PageTemplate(
                    id="content",
                    frames=[frame],
                    onPage=self.draw_page,
                )
            ]
        )

    def draw_page(self, canvas, doc) -> None:
        canvas.saveState()
        if doc.page == 1:
            canvas.setFillColor(NAVY)
            canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
            canvas.setFillColor(TEAL)
            canvas.rect(0, 0, 12 * mm, PAGE_HEIGHT, fill=1, stroke=0)
        else:
            canvas.setStrokeColor(colors.HexColor("#D4DEE5"))
            canvas.setLineWidth(0.5)
            canvas.line(18 * mm, PAGE_HEIGHT - 13 * mm, PAGE_WIDTH - 18 * mm, PAGE_HEIGHT - 13 * mm)
            canvas.setFont("FixtureSans", 7.5)
            canvas.setFillColor(MID_GREY)
            canvas.drawString(18 * mm, PAGE_HEIGHT - 10 * mm, self.document_title)
            canvas.drawRightString(PAGE_WIDTH - 18 * mm, 10 * mm, f"Side {doc.page}")
            canvas.setFillColor(TEAL)
            canvas.rect(18 * mm, PAGE_HEIGHT - 13.5 * mm, 28 * mm, 1 * mm, fill=1, stroke=0)
        canvas.restoreState()


def p(value: str, style) -> Paragraph:
    return Paragraph(value, style)


def cover_story(document_label: str, title: str, status_line: str, style_map) -> list:
    return [
        Spacer(1, 48 * mm),
        p(document_label, style_map["cover_subtitle"]),
        Spacer(1, 4 * mm),
        p(title, style_map["cover_title"]),
        p(
            "Nordhavn kommune | Anskaffelse 26/1847 | SSA-L 2026",
            style_map["cover_subtitle"],
        ),
        Spacer(1, 52 * mm),
        p(status_line, style_map["cover_subtitle"]),
        Spacer(1, 8 * mm),
        p(
            "Fiktivt testdokument basert på offentlig bilagsstruktur. Ikke et reelt konkurransedokument.",
            style_map["cover_subtitle"],
        ),
        PageBreak(),
    ]


def callout(text: str, style_map) -> Table:
    table = Table([[p(text, style_map["callout"])]], colWidths=[168 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PALE_TEAL),
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#A7D6D1")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
            ]
        )
    )
    return table


def append_sections(story: list, sections: Iterable[tuple[str, list[str]]], style_map) -> None:
    for heading, paragraphs in sections:
        story.append(p(heading, style_map["h1"]))
        for paragraph in paragraphs:
            story.append(p(paragraph, style_map["body"]))


def requirement_table(requirements: list[Requirement], style_map, include_answer: bool) -> LongTable:
    if include_answer:
        header = [
            p("Krav-ID", style_map["small_header"]),
            p("Type", style_map["small_header"]),
            p("Kundens krav", style_map["small_header"]),
            p("Status og leverandørens besvarelse", style_map["small_header"]),
        ]
        widths = [20 * mm, 12 * mm, 60 * mm, 76 * mm]
    else:
        header = [
            p("Krav-ID", style_map["small_header"]),
            p("Type", style_map["small_header"]),
            p("Kundens krav", style_map["small_header"]),
            p("Svarinstruks", style_map["small_header"]),
        ]
        widths = [20 * mm, 12 * mm, 77 * mm, 59 * mm]

    rows = [header]
    for requirement in requirements:
        answer = (
            f"<b>{requirement.supplier_status}</b><br/>{requirement.supplier_answer}"
            if include_answer
            else requirement.answer_instruction
        )
        rows.append(
            [
                p(requirement.requirement_id, style_map["small_bold"]),
                p(requirement.category, style_map["small_bold"]),
                p(
                    f"<b>{requirement.topic}</b><br/>{requirement.requirement}",
                    style_map["small"],
                ),
                p(answer, style_map["small"]),
            ]
        )

    table = LongTable(
        rows,
        colWidths=widths,
        repeatRows=1,
        splitByRow=1,
        hAlign="LEFT",
    )
    style_commands = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#B8C5CE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.1 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.1 * mm),
    ]
    for row_index, requirement in enumerate(requirements, start=1):
        background = (
            colors.HexColor("#F8FAFB")
            if row_index % 2
            else WHITE
        )
        style_commands.append(("BACKGROUND", (0, row_index), (-1, row_index), background))
        if requirement.category == "A":
            style_commands.append(("BACKGROUND", (1, row_index), (1, row_index), PALE_BLUE))
        else:
            style_commands.append(("BACKGROUND", (1, row_index), (1, row_index), PALE_TEAL))
    table.setStyle(TableStyle(style_commands))
    return table


def build_bilag_1(style_map) -> tuple[list, str]:
    story = cover_story(
        "BILAG 1",
        "Kundens behovs- og kravspesifikasjon",
        "Konkurranseversjon 1.0 | 24. juli 2026",
        style_map,
    )
    story.append(
        callout(
            "<b>Leserveiledning:</b> Bilag 1 er Kundens dokument. Kravene skal besvares i Bilag 2 uten at kravtekst eller krav-ID endres.",
            style_map,
        )
    )
    append_sections(story, BILAG_1_SECTIONS[:5], style_map)
    story.append(p("6. Kravtabell", style_map["h1"]))
    story.append(
        p(
            "Tabellen nedenfor er kontraktsgrunnlaget for de beskrevne kravene. Besvarelsesinstruksene erstattes av Leverandørens svar i Bilag 2.",
            style_map["body"],
        )
    )
    story.append(requirement_table(REQUIREMENTS, style_map, include_answer=False))
    append_sections(story, BILAG_1_SECTIONS[5:], style_map)
    text_parts = [
        "BILAG 1 - KUNDENS BEHOVS- OG KRAVSPESIFIKASJON",
        "Nordhavn kommune | Anskaffelse 26/1847 | SSA-L 2026",
    ]
    for heading, paragraphs in BILAG_1_SECTIONS[:5]:
        text_parts.extend([heading, *paragraphs])
    text_parts.append("6. Kravtabell")
    for requirement in REQUIREMENTS:
        text_parts.extend(
            [
                f"{requirement.requirement_id} | {requirement.category} | {requirement.topic}",
                requirement.requirement,
                f"Svarinstruks: {requirement.answer_instruction}",
            ]
        )
    for heading, paragraphs in BILAG_1_SECTIONS[5:]:
        text_parts.extend([heading, *paragraphs])
    return story, "\n\n".join(text_parts) + "\n"


def solution_overview_table(style_map) -> Table:
    rows = [
        [p("Område", style_map["small_bold"]), p("Tilbudt løsning", style_map["small_bold"])],
        [p("Tjeneste", style_map["small_bold"]), p("Saksløft Cloud 4.2, standardisert SaaS", style_map["small"])],
        [p("Driftsregion", style_map["small_bold"]), p("Microsoft Azure i Norge, med behandlingssteder innenfor EØS", style_map["small"])],
        [p("Identitet", style_map["small_bold"]), p("Microsoft Entra ID for ansatte og ID-porten for eksterne brukere", style_map["small"])],
        [p("Integrasjon", style_map["small_bold"]), p("REST, OpenAPI 3.1, webhooks, SCIM og avtalte nasjonale fellesløsninger", style_map["small"])],
        [p("Tilgjengelighet", style_map["small_bold"]), p("99,95 prosent per måned, RPO 1 time og RTO 4 timer", style_map["small"])],
        [p("Produksjonsstart", style_map["small_bold"]), p("1. april 2027", style_map["small"])],
    ]
    table = Table(rows, colWidths=[42 * mm, 126 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#B8C5CE")),
                ("BACKGROUND", (0, 1), (0, -1), PALE_BLUE),
                ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
            ]
        )
    )
    return table


def build_bilag_2(style_map) -> tuple[list, str]:
    story = cover_story(
        "BILAG 2",
        "Leverandørens beskrivelse av tjenesten",
        "Tilbud fra KystSky AS | Versjon 1.0 | 24. juli 2026",
        style_map,
    )
    story.append(
        callout(
            "<b>Besvarelsesregel:</b> KystSky har beholdt Kundens kravtekst og krav-ID. Hvert svar bekrefter oppfyllelse og forklarer hvordan kravet leveres.",
            style_map,
        )
    )
    append_sections(story, BILAG_2_SECTIONS[:2], style_map)
    story.append(p("3. Løsningsoversikt", style_map["h1"]))
    story.append(solution_overview_table(style_map))
    story.append(Spacer(1, 3 * mm))
    story.append(p("3.1 Besvarelse av Kundens krav", style_map["h2"]))
    story.append(
        p(
            "Besvarelsene nedenfor er bindende for tilbudet. Eventuelle forutsetninger er oppgitt i svaret eller i kapittel 2.",
            style_map["body"],
        )
    )
    story.append(requirement_table(REQUIREMENTS, style_map, include_answer=True))
    append_sections(story, BILAG_2_SECTIONS[2:], style_map)
    story.append(
        KeepTogether(
            [
                p("7. Erklæring", style_map["h1"]),
                p(
                    "KystSky AS bekrefter at tilbudt tjeneste oppfyller alle A-krav. B-kravene oppfylles som beskrevet i dette bilaget. Det er ikke tatt forbehold som endrer Kundens kravtekst.",
                    style_map["body"],
                ),
            ]
        )
    )
    text_parts = [
        "BILAG 2 - LEVERANDØRENS BESKRIVELSE AV TJENESTEN",
        "Tilbud fra KystSky AS | Nordhavn kommune | Anskaffelse 26/1847",
    ]
    for heading, paragraphs in BILAG_2_SECTIONS[:2]:
        text_parts.extend([heading, *paragraphs])
    text_parts.extend(
        [
            "3. Løsningsoversikt",
            "Tjeneste: Saksløft Cloud 4.2, standardisert SaaS",
            "Driftsregion: Microsoft Azure i Norge, med behandlingssteder innenfor EØS",
            "Identitet: Microsoft Entra ID for ansatte og ID-porten for eksterne brukere",
            "Integrasjon: REST, OpenAPI 3.1, webhooks, SCIM og avtalte nasjonale fellesløsninger",
            "Tilgjengelighet: 99,95 prosent per måned, RPO 1 time og RTO 4 timer",
            "Produksjonsstart: 1. april 2027",
            "3.1 Besvarelse av Kundens krav",
        ]
    )
    for requirement in REQUIREMENTS:
        text_parts.extend(
            [
                f"{requirement.requirement_id} | {requirement.category} | {requirement.topic}",
                f"Kundens krav: {requirement.requirement}",
                f"Status: {requirement.supplier_status}",
                f"Leverandørens besvarelse: {requirement.supplier_answer}",
            ]
        )
    for heading, paragraphs in BILAG_2_SECTIONS[2:]:
        text_parts.extend([heading, *paragraphs])
    text_parts.extend(
        [
            "7. Erklæring",
            "KystSky AS bekrefter at tilbudt tjeneste oppfyller alle A-krav. B-kravene oppfylles som beskrevet i dette bilaget. Det er ikke tatt forbehold som endrer Kundens kravtekst.",
        ]
    )
    return story, "\n\n".join(text_parts) + "\n"


def assert_language_and_source_quality(text: str) -> None:
    forbidden_dashes = {"‐", "‑", "‒", "–", "—"}
    found_dashes = sorted(forbidden_dashes.intersection(text))
    if found_dashes:
        raise ValueError(f"Fant forbudte Unicode-bindestreker: {found_dashes}")
    if "  " in text:
        raise ValueError("Fant doble mellomrom i kildeteksten.")
    if any(token in text for token in (" Ã", "�")):
        raise ValueError("Fant mulig tegnkodingsfeil i kildeteksten.")
    if "i henhold til" in text:
        raise ValueError("Bruk 'i samsvar med' eller en mer presis formulering.")


def write_document(
    filename: str,
    title: str,
    story: list,
    plain_text: str,
) -> dict:
    assert_language_and_source_quality(plain_text)
    pdf_path = OUTPUT_DIR / filename
    txt_path = pdf_path.with_suffix(".txt")
    FixtureDocTemplate(pdf_path, title).build(story)
    txt_path.write_text(plain_text, encoding="utf-8")
    page_count = len(PdfReader(str(pdf_path)).pages)
    if page_count < 2:
        raise ValueError(f"{filename} ble bare {page_count} side(r).")
    return {
        "filename": filename,
        "text_filename": txt_path.name,
        "pages": page_count,
        "bytes": pdf_path.stat().st_size,
    }


def main() -> None:
    register_fonts()
    style_map = styles()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    bilag_1_story, bilag_1_text = build_bilag_1(style_map)
    bilag_2_story, bilag_2_text = build_bilag_2(style_map)
    documents = [
        write_document(
            "bilag1_nordhavn_byggesak_2026.pdf",
            "Bilag 1 - Nordhavn kommune",
            bilag_1_story,
            bilag_1_text,
        ),
        write_document(
            "bilag2_nordhavn_byggesak_2026.pdf",
            "Bilag 2 - KystSky AS",
            bilag_2_story,
            bilag_2_text,
        ),
    ]
    (OUTPUT_DIR / "expected-customer-analysis-facts.json").write_text(
        json.dumps(EXPECTED_FACTS, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "fixture": "Nordhavn kommune - digital byggesaksbehandling",
        "generated_at": "2026-07-24",
        "contract_pattern": "SSA-L 2026",
        "fictional": True,
        "requirement_count": len(REQUIREMENTS),
        "documents": documents,
    }
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for document in documents:
        print(
            f"Created {document['filename']} "
            f"({document['pages']} pages, {document['bytes']} bytes)"
        )


if __name__ == "__main__":
    main()

"""Fiktivt, norsk konkurransegrunnlag for ende-til-ende-test av Anbud (2026-10-31).

Gjenbruker stil og verktøy fra scripts/generate_complex_tender_corpus.py
(reportlab + pypdf) og skriver DOCX med python-docx. All tekst som havner i
dokumentene kommer fra datastrukturene under, slik at fasiten er ordrett lik
kilden. Kjør med reportlab, pypdf og python-docx installert: python -I generate_tender.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from docx import Document
from docx.shared import Pt
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = Path(__file__).resolve().parent / "documents"
OUT.mkdir(exist_ok=True)

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT = RIGHT = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT - RIGHT
INK = colors.HexColor("#1A2633")
NAVY = colors.HexColor("#12324A")
BLUE = colors.HexColor("#245B78")
LIGHT_BLUE = colors.HexColor("#EAF2F7")
LIGHT_GREY = colors.HexColor("#F3F5F7")
LINE = colors.HexColor("#C8D2D9")
MID_GREY = colors.HexColor("#64727D")

# Another font changes the PDF layout, and with it the page numbers in fasit.json.
pdfmetrics.registerFont(TTFont("TenderSans", os.environ.get("TENDER_FONT", "/System/Library/Fonts/Supplemental/Arial.ttf")))
pdfmetrics.registerFont(TTFont("TenderSans-Bold", os.environ.get("TENDER_FONT_BOLD", "/System/Library/Fonts/Supplemental/Arial Bold.ttf")))
FONT, FONT_BOLD = "TenderSans", "TenderSans-Bold"
_s = getSampleStyleSheet()
STYLES = {
    "body": ParagraphStyle("b", parent=_s["BodyText"], fontName=FONT, fontSize=9.8, leading=13.4, textColor=INK, spaceAfter=6),
    "small": ParagraphStyle("s", parent=_s["BodyText"], fontName=FONT, fontSize=8.6, leading=11.4, textColor=INK),
    "th": ParagraphStyle("th", parent=_s["BodyText"], fontName=FONT_BOLD, fontSize=8.2, leading=10, textColor=colors.white, alignment=TA_LEFT),
    "title": ParagraphStyle("t", parent=_s["Title"], fontName=FONT_BOLD, fontSize=22, leading=27, textColor=NAVY, alignment=TA_LEFT, spaceAfter=10),
    "subtitle": ParagraphStyle("st", parent=_s["BodyText"], fontName=FONT, fontSize=12, leading=16, textColor=MID_GREY, spaceAfter=16),
    "h1": ParagraphStyle("h1", parent=_s["Heading1"], fontName=FONT_BOLD, fontSize=14.5, leading=18, textColor=NAVY, spaceBefore=10, spaceAfter=6, keepWithNext=True),
    "h2": ParagraphStyle("h2", parent=_s["Heading2"], fontName=FONT_BOLD, fontSize=11.5, leading=14, textColor=BLUE, spaceBefore=8, spaceAfter=5, keepWithNext=True),
    "caption": ParagraphStyle("cap", parent=_s["BodyText"], fontName=FONT_BOLD, fontSize=10, leading=13, textColor=BLUE, spaceBefore=6, spaceAfter=4),
    "bullet": ParagraphStyle("bl", parent=_s["BodyText"], fontName=FONT, fontSize=9.6, leading=13, textColor=INK, leftIndent=14, firstLineIndent=-9, spaceAfter=3),
}


def P(text: str, style: str = "body") -> Paragraph:
    return Paragraph(escape(text), STYLES[style])


def grid(rows: list[list[Any]], widths: list[float], *, long: bool = False) -> Table:
    cls = LongTable if long else Table
    table = cls(rows, colWidths=widths, repeatRows=1, splitByRow=True, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_GREY]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def footer(label: str):
    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MID_GREY)
        canvas.drawString(LEFT, 11 * mm, f"Hålandsvik kommune · Saksnr. 2026/1184 · {label}")
        canvas.drawRightString(PAGE_WIDTH - RIGHT, 11 * mm, f"Side {doc.page}")
        canvas.restoreState()
    return draw


def build_pdf(path: Path, story: list[Any], label: str) -> None:
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT,
                            topMargin=20 * mm, bottomMargin=18 * mm, title=label,
                            author="Hålandsvik kommune")
    doc.build(story, onFirstPage=footer(label), onLaterPages=footer(label))


# --------------------------------------------------------------------------
# Kildedata (fasiten bygger på nøyaktig disse strengene)
# --------------------------------------------------------------------------

CUSTOMER = "Hålandsvik kommune"
PROJECT = "Skyplattform og drift av kommunale fagsystemer"

# (id, type, text, layout) - layout: prose | table3 | table41 | list42 | prose5 | prose6
REQUIREMENTS: list[dict[str, Any]] = [
    {"id": "K-2.1", "kind": "skal", "section": "2 Generelle krav", "layout": "prose",
     "text": "Leverandøren skal ha et styringssystem for informasjonssikkerhet som er sertifisert etter ISO/IEC 27001:2022. Gyldig sertifikat skal legges ved tilbudet."},
    {"id": "K-2.2", "kind": "bør", "section": "2 Generelle krav", "layout": "prose",
     "text": "Leverandøren bør ha minst tre referanseprosjekter fra de siste fem årene der leverandøren har driftet skybaserte fagsystemer for kommuner eller fylkeskommuner med mer enn 500 brukere."},
    {"id": "K-2.3", "kind": "skal", "section": "2 Generelle krav", "layout": "prose",
     "text": "Leverandøren skal utpeke en navngitt kundeansvarlig og en teknisk kontaktperson som begge behersker norsk muntlig og skriftlig."},
    {"id": "K-3.1.1", "kind": "skal", "section": "3.1 Hosting og dataplassering", "layout": "table3",
     "text": "Alle kundedata, inkludert sikkerhetskopier og logger, skal lagres og behandles i datasentre innenfor EØS."},
    {"id": "K-3.1.2", "kind": "skal", "section": "3.1 Hosting og dataplassering", "layout": "table3",
     "text": "Plattformen skal driftes fra minst to geografisk adskilte datasentre med en avstand på minst 30 km mellom primær- og sekundærlokasjon, slik at bortfall av ett datasenter ikke medfører tap av data."},
    {"id": "K-3.1.3", "kind": "bør", "section": "3.1 Hosting og dataplassering", "layout": "table3",
     "text": "Leverandøren bør tilby lagring i datasentre i Norge for særlige kategorier av personopplysninger, uten tillegg i pris."},
    {"id": "K-3.1.4", "kind": "bør", "section": "3.1 Hosting og dataplassering", "layout": "table3",
     "text": "Plattformen bør drives med minst 90 % fornybar energi, dokumentert med opprinnelsesgarantier eller tilsvarende."},
    {"id": "K-3.2.1", "kind": "skal", "section": "3.2 Nettverk og tilkobling", "layout": "table3",
     # Bevisst manuelt linjeskift midt i setningen i tabellcellen.
     "text": "Leverandøren skal etablere kryptert forbindelse (IPsec VPN eller privat linje) mellom kommunens nett i Hålandsvik rådhus og skyplattformen, med en båndbredde på minst 1 Gbit/s.",
     "break_after": "mellom kommunens nett i Hålandsvik rådhus"},
    {"id": "K-3.2.2", "kind": "skal", "section": "3.2 Nettverk og tilkobling", "layout": "table3",
     "text": "All administrativ tilgang til plattformen skal skje med flerfaktorautentisering via et eget administrasjonsnett som er logisk adskilt fra brukertrafikken."},
    {"id": "K-3.2.3", "kind": "bør", "section": "3.2 Nettverk og tilkobling", "layout": "table3",
     "text": "Leverandøren bør støtte IPv6 i hele plattformen innen 12 måneder etter kontraktsinngåelse."},
    {"id": "K-3.3.1", "kind": "skal", "section": "3.3 Driftssenter og personell", "layout": "table3",
     "text": "Leverandørens driftssenter skal være bemannet 24 timer i døgnet, 7 dager i uken, og ligge innenfor EØS."},
    {"id": "K-3.3.2", "kind": "skal", "section": "3.3 Driftssenter og personell", "layout": "table3",
     "text": "Personell med administrativ tilgang til kommunens miljø skal ha levert politiattest som ikke er eldre enn tre måneder ved tiltredelse."},
    {"id": "K-3.3.3", "kind": "bør", "section": "3.3 Driftssenter og personell", "layout": "table3",
     "text": "Leverandøren bør stille med et fast team på minst fire navngitte driftsressurser for Hålandsvik kommune, hvorav minst én har sertifisering på ekspertnivå innen den tilbudte skyplattformen."},
    {"id": "K-4.1.1", "kind": "skal", "section": "4.1 Tjenestenivå", "layout": "table41",
     "text": "Tilgjengeligheten for kritiske fagsystemer (Gerica, Visma Flyt Skole og Acos WebSak) skal være minst 99,8 % per måned, målt i tidsrommet 06:00–22:00 alle dager."},
    {"id": "K-4.1.2", "kind": "skal", "section": "4.1 Tjenestenivå", "layout": "table41",
     "text": "Leverandøren skal gjenopprette kritiske fagsystemer innen 8 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 1 time (RPO).",
     "superseded_by": "Leverandøren skal gjenopprette kritiske fagsystemer innen 4 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 15 minutter (RPO)."},
    {"id": "K-4.1.3", "kind": "bør", "section": "4.1 Tjenestenivå", "layout": "table41",
     "text": "Leverandøren bør levere en månedlig tjenestenivårapport med trendanalyse og forslag til forbedringstiltak innen femte virkedag i påfølgende måned."},
    {"id": "K-4.2.1", "kind": "skal", "section": "4.2 Hendelseshåndtering", "layout": "list42",
     "text": "Kritiske hendelser skal besvares innen 15 minutter hele døgnet, og kommunens IT-vakt skal varsles på telefon innen 30 minutter."},
    {"id": "K-4.2.2", "kind": "skal", "section": "4.2 Hendelseshåndtering", "layout": "list42",
     "text": "Leverandøren skal kunne stille med tekniker fysisk på Hålandsvik rådhus innen 4 timer ved kritiske hendelser, hele døgnet."},
    {"id": "K-4.2.3", "kind": "bør", "section": "4.2 Hendelseshåndtering", "layout": "list42",
     "text": "Leverandøren bør gjennomføre en felles beredskapsøvelse med kommunen minst én gang per år, inkludert full gjenoppretting av minst ett kritisk fagsystem fra sikkerhetskopi."},
    {"id": "K-5.1", "kind": "skal", "section": "5 Sikkerhet og personvern", "layout": "prose5",
     "text": "Leverandøren skal inngå databehandleravtale med kommunen i tråd med personvernforordningen artikkel 28, basert på kommunens mal i Bilag 5."},
    {"id": "K-5.2", "kind": "skal", "section": "5 Sikkerhet og personvern", "layout": "prose5",
     "text": "Sikkerhetsbrudd som berører personopplysninger skal meldes til kommunen uten ugrunnet opphold og senest 24 timer etter at leverandøren ble kjent med bruddet."},
    {"id": "K-5.3", "kind": "bør", "section": "5 Sikkerhet og personvern", "layout": "prose5",
     "text": "Kommunen bør kunne forvalte egne krypteringsnøkler (kundestyrte nøkler) for lagring av særlige kategorier av personopplysninger."},
    {"id": "K-6.1", "kind": "skal", "section": "6 Overgang og exit", "layout": "prose6",
     "text": "Leverandøren skal levere en exitplan senest 3 måneder etter kontraktsinngåelse. Exitplanen skal minst omfatte:",
     "bullets": [
         "a) eksport av alle data i åpne, dokumenterte formater,",
         "b) tidsplan for tilbakeføring til kommunen eller ny leverandør, og",
         "c) ansvarsfordeling og bistand ved overføring til ny leverandør.",
     ]},
    {"id": "K-6.2", "kind": "bør", "section": "6 Overgang og exit", "layout": "prose6",
     "text": "Leverandøren bør gjennomføre migreringen fra dagens løsning uten nedetid for kritiske fagsystemer i kommunens åpningstid (08:00–15:30)."},
]
assert len(REQUIREMENTS) == 24
assert sum(r["kind"] == "skal" for r in REQUIREMENTS) == 15

DISTRACTOR = (
    "Under den forrige driftsavtalen med Fjellnett Drift AS (2019–2025) skulle "
    "sikkerhetskopier tas ut på bånd hver fredag og fraktes til kommunens serverrom "
    "på Kvernhusbakken, og leverandøren måtte gjenopprette data manuelt fra bånd ved "
    "behov. Ordningen ble avviklet i februar 2025 og videreføres ikke."
)

QUALIFICATION = [
    "Leverandøren må ha hatt en årlig omsetning på minst NOK 25 millioner i siste avlagte regnskapsår.",
    "Leverandøren må dokumentere minst to gjennomførte driftsoppdrag av tilsvarende art og omfang de siste tre årene.",
    "Leverandøren må ha et ledelsessystem for informasjonssikkerhet, dokumentert med sertifikat eller tilsvarende beskrivelse.",
]

TIMELINE = [
    ("Kunngjøring i Doffin og KGV", "2. oktober 2026"),
    ("Frist for å stille spørsmål", "20. oktober 2026 kl. 12:00"),
    ("Tilbudsfrist", "3. november 2026 kl. 12:00"),
    ("Vedståelsesfrist", "28. februar 2027"),
    ("Planlagt kontraktsinngåelse", "januar 2027"),
    ("Oppstart av driftsavtalen", "1. mars 2027"),
]

VALUE_ROWS = [
    ("Basisavtale, 3 år (1. mars 2027–28. februar 2030)", "NOK 11 200 000"),
    ("Opsjon 1: forlengelse 1 + 1 år", "NOK 4 800 000"),
    ("Opsjon 2: utvidelse til Nordre Fjære kommune (ca. 600 brukere)", "NOK 2 400 000"),
    ("Anslått samlet verdi inkludert opsjoner", "NOK 18 400 000"),
]

CRITERIA = [
    ("1 Pris", "40 %", "Samlet evaluert pris for tre år basert på prisskjemaet i Bilag 3."),
    ("2 Kvalitet", "35 %", "Underkriterium 2.1 Arkitektur og sikkerhet (20 %) og underkriterium 2.2 Drift, beredskap og tjenestenivå (15 %). Besvarelsen av bør-kravene K-3.1.3, K-3.2.3, K-3.3.3, K-4.1.3, K-4.2.3, K-5.3 og K-6.2 inngår."),
    ("3 Gjennomføring og kompetanse", "15 %", "Plan for overgang, CV-er for nøkkelpersonell og bør-kravet K-2.2."),
    ("4 Miljø og bærekraft", "10 %", "Dokumentert energikilde og klimatiltak, herunder bør-kravet K-3.1.4."),
]

# --------------------------------------------------------------------------
# 01 Konkurransegrunnlag (primary_customer_document, PDF)
# --------------------------------------------------------------------------


def main_document() -> None:
    s: list[Any] = [Spacer(1, 12 * mm), P("KONKURRANSEGRUNNLAG", "h2"),
                    P(PROJECT, "title"),
                    P("Åpen anbudskonkurranse · Saksnr. 2026/1184 · Versjon 1.1 (14. oktober 2026, rettelse nr. 1 er tatt inn i kapittel 9)", "subtitle")]
    meta = [["Oppdragsgiver", "Hålandsvik kommune, org.nr. 940 512 337"],
            ["Adresse", "Rådhusplassen 1, 5799 Hålandsvik"],
            ["Kontaktperson", "Åsmund Kjærstad, innkjøpsrådgiver (all kommunikasjon via KGV)"],
            ["Prosedyre", "Åpen anbudskonkurranse etter anskaffelsesforskriften del III"],
            ["Avtaletype", "SSA-D (Statens standardavtale for driftsavtaler)"]]
    t = Table([[Paragraph(f'<font name="{FONT_BOLD}">{escape(a)}</font>', STYLES["small"]), P(b, "small")] for a, b in meta],
              colWidths=[38 * mm, CONTENT_WIDTH - 38 * mm], hAlign="LEFT")
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, -1), LIGHT_BLUE), ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                           ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE), ("TOPPADDING", (0, 0), (-1, -1), 5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    s += [t, Spacer(1, 6 * mm), P("Alle virksomheter, personer og tall i dette dokumentet er fiktive og laget for testformål.", "small"), PageBreak()]

    s += [P("1 Innledning og oppdragsgiver", "h1"),
          P("Hålandsvik kommune har om lag 14 200 innbyggere og 1 150 ansatte fordelt på rådhuset, ni skoler, fire sykehjem og hjemmetjenesten. Kommunens IT-seksjon har åtte årsverk og forvalter om lag 40 fagsystemer."),
          P("Kommunen inviterer med dette til åpen anbudskonkurranse om drift av en skyplattform for kommunens fagsystemer, inkludert overgang fra dagens lokale serverrom. Anskaffelsen gjennomføres i konkurransegjennomføringsverktøyet KGV, og all kommunikasjon om konkurransen skal skje der."),
          P("2 Bakgrunn og mål", "h1"),
          P("Kommunens fagsystemer driftes i dag i et eget serverrom i rådhuskjelleren. Rommet har ikke tilfredsstillende brannsikring, og det mangler reservestrøm utover 30 minutter. Tilsynsrapporten fra 2025 påpekte at kommunen er sårbar for lengre driftsavbrudd."),
          P("Målene med anskaffelsen er å redusere risikoen for langvarige avbrudd i kritiske tjenester, frigjøre IT-seksjonen fra maskinvarenær drift, sikre etterlevelse av personvernregelverket og gi kommunen forutsigbare driftskostnader. Kommunen ønsker også å legge til rette for et tettere interkommunalt samarbeid med Nordre Fjære kommune."),
          P("3 Anskaffelsens omfang", "h1"),
          P("Oppdraget omfatter etablering og drift av skyplattform, nettverkstilkobling, sikkerhetskopiering, overvåking, hendelseshåndtering og migrering av fagsystemene. Applikasjonsforvaltning av den enkelte fagsystemleverandørens programvare inngår ikke. Detaljerte krav står i Bilag 1 Kravspesifikasjon."),
          P("4 Kontrakt, varighet, verdi og opsjoner", "h1"),
          P("Kontrakten inngås for tre år fra 1. mars 2027, med opsjon for kommunen på forlengelse i 1 + 1 år. Kommunen har i tillegg opsjon på å utvide avtalen til å omfatte Nordre Fjære kommune. Opsjonene utløses etter kommunens ensidige beslutning. Anslått verdi er oppgitt eksklusive merverdiavgift:"),
          grid([[P("Del", "th"), P("Anslått verdi ekskl. mva.", "th")]] + [[P(a, "small"), P(b, "small")] for a, b in VALUE_ROWS],
               [CONTENT_WIDTH - 50 * mm, 50 * mm]),
          Spacer(1, 3 * mm),
          P("Verdien er et estimat og ikke en forpliktelse for kommunen. Avtalens maksimale verdi er NOK 18 400 000 ekskl. mva.; når denne er nådd, opphører avtalen."),
          P("5 Prosedyre og frister", "h1"),
          P("5.1 Tidsplan", "h2"),
          grid([[P("Aktivitet", "th"), P("Frist / dato", "th")]] + [[P(a, "small"), P(b, "small")] for a, b in TIMELINE],
               [CONTENT_WIDTH - 60 * mm, 60 * mm]),
          Spacer(1, 3 * mm),
          P("Spørsmål som kommer inn etter spørsmålsfristen, vil bare bli besvart dersom kommunen finner det hensiktsmessig. Tilbud som kommer inn etter tilbudsfristen, vil bli avvist."),
          P("5.2 Forhandlinger", "h2"),
          P("Det er ikke adgang til å forhandle i en åpen anbudskonkurranse. Kommunen kan be om avklaringer av uklarheter i tilbudet."),
          P("6 Kvalifikasjonskrav", "h1"),
          P("Leverandørene skal fylle ut ESPD i KGV. Følgende kvalifikasjonskrav gjelder:")]
    s += [P(f"• {q}", "bullet") for q in QUALIFICATION]
    s += [P("7 Tildeling", "h1"),
          P("Tildeling skjer på grunnlag av beste forhold mellom pris og kvalitet. Tildelingskriterier, vekter og evalueringsmodell fremgår av Bilag 2 Evaluering og tildeling."),
          P("8 Tilbudets innhold", "h1"),
          P("Tilbudet skal inneholde utfylt ESPD, besvarelse av alle krav i Bilag 1, utfylt prisskjema (Bilag 3), utfylt databehandleravtale (Bilag 5) og eventuelle forbehold samlet i ett eget dokument. Forbehold mot minstekrav i Bilag 1 medfører avvisning."),
          PageBreak(),
          P("9 Rettelser og presiseringer (Rettelse nr. 1 av 14.10.2026)", "h1"),
          P("Dette kapitlet går foran tidligere publisert tekst i konkurransegrunnlaget og bilagene."),
          P("1. Tilbudsfristen i punkt 5.1 endres fra 3. november 2026 kl. 12:00 til 10. november 2026 kl. 12:00. Øvrige datoer i tidsplanen står uendret."),
          P("2. Krav K-4.1.2 i Bilag 1 endres og skal nå lyde: «Leverandøren skal gjenopprette kritiske fagsystemer innen 4 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 15 minutter (RPO).»"),
          P("3. Spørsmål fra leverandør: Kan driftssenteret i K-3.3.1 ligge utenfor Norden? Svar: Ja, så lenge driftssenteret ligger innenfor EØS. Kravet står uendret.")]
    build_pdf(OUT / "01_Konkurransegrunnlag_Halandsvik_kommune.pdf", s, "Konkurransegrunnlag v1.1")


# --------------------------------------------------------------------------
# 02 Bilag 1 Kravspesifikasjon (supporting_document/kravdokument, PDF)
# --------------------------------------------------------------------------


def req_rows(layout: str, *, with_type: bool = True) -> list[list[Any]]:
    rows: list[list[Any]] = [[P("Krav-ID", "th"), P("Type", "th"), P("Kravtekst", "th")]]
    for r in REQUIREMENTS:
        if r["layout"] != layout:
            continue
        kind = "Minstekrav" if r["kind"] == "skal" else "Evalueres"
        text = escape(r["text"])
        if r.get("break_after"):
            head = escape(r["break_after"])
            text = text.replace(head, head + "<br/>", 1)
        rows.append([Paragraph(f'<font name="{FONT_BOLD}">{r["id"]}</font>', STYLES["small"]),
                     P(kind, "small"), Paragraph(text, STYLES["small"])])
    return rows


def bilag1() -> None:
    s: list[Any] = [P("BILAG 1", "h2"), P("Kravspesifikasjon", "title"),
                    P(f"{PROJECT} · {CUSTOMER} · Saksnr. 2026/1184", "subtitle"),
                    P("1 Innledning", "h1"),
                    P("Dette bilaget beskriver kommunens krav til leveransen. Alle krav har en unik krav-ID på formen K-x.y eller K-x.y.z. Krav formulert med «skal» er minstekrav; manglende oppfyllelse av et minstekrav medfører avvisning av tilbudet. Krav formulert med «bør» evalueres etter tildelingskriteriene i Bilag 2."),
                    P("Leverandøren skal besvare hvert krav i tilbudets kravsvar med en konkret beskrivelse av hvordan kravet oppfylles. Tekst uten krav-ID er bakgrunn og veiledning."),
                    P("2 Generelle krav", "h1")]
    for r in REQUIREMENTS:
        if r["layout"] == "prose":
            s.append(Paragraph(f'<font name="{FONT_BOLD}">{r["id"]}</font> {escape(r["text"])}', STYLES["body"]))
    s += [P("3 Plattform og arkitektur", "h1"),
          P("Kommunen ønsker en standardisert skyplattform med tydelig ansvarsdeling mellom leverandør og kommune. Leverandøren står fritt til å velge offentlig skyplattform, så lenge kravene under er oppfylt. Kravene i kapittel 3 er samlet i én tabell som dekker underkapitlene 3.1 Hosting og dataplassering, 3.2 Nettverk og tilkobling og 3.3 Driftssenter og personell."),
          P("Ved vurderingen av kapittel 3 vil kommunen legge vekt på robusthet, enkel forvaltning og at løsningen kan utvides til Nordre Fjære kommune uten ny arkitektur. Kommunen har i dag om lag 1 150 brukere og forventer en vekst på inntil 5 % per år i kontraktsperioden."),
          P("Tabell 3-1 Krav til plattform, nettverk og driftssenter", "caption"),
          grid(req_rows("table3"), [22 * mm, 22 * mm, CONTENT_WIDTH - 44 * mm], long=True),
          P("4 Drift, beredskap og gjenoppretting", "h1"),
          P("Bakgrunn", "h2"),
          P(DISTRACTOR),
          P("4.1 Tjenestenivå", "h2"),
          grid(req_rows("table41"), [22 * mm, 22 * mm, CONTENT_WIDTH - 44 * mm]),
          P("4.2 Hendelseshåndtering", "h2"),
          P("Følgende krav gjelder for håndtering av hendelser i hele kontraktsperioden:")]
    for r in REQUIREMENTS:
        if r["layout"] == "list42":
            s.append(Paragraph(f'<font name="{FONT_BOLD}">{r["id"]}</font> {escape(r["text"])}', STYLES["bullet"]))
    s += [P("5 Sikkerhet og personvern", "h1"),
          P("Kommunen behandler helseopplysninger, opplysninger om barn og andre særlige kategorier av personopplysninger. Kommunen er behandlingsansvarlig og leverandøren databehandler.")]
    for r in REQUIREMENTS:
        if r["layout"] == "prose5":
            s.append(Paragraph(f'<font name="{FONT_BOLD}">{r["id"]}</font> {escape(r["text"])}', STYLES["body"]))
    s.append(P("6 Overgang og exit", "h1"))
    for r in REQUIREMENTS:
        if r["layout"] == "prose6":
            s.append(Paragraph(f'<font name="{FONT_BOLD}">{r["id"]}</font> {escape(r["text"])}', STYLES["body"]))
            for b in r.get("bullets", []):
                s.append(P(b, "bullet"))
    build_pdf(OUT / "02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf", s, "Bilag 1 Kravspesifikasjon")


# --------------------------------------------------------------------------
# 03 Bilag 2 Evaluering (supporting_document, DOCX)
# --------------------------------------------------------------------------


def docx_doc() -> Document:
    d = Document()
    d.styles["Normal"].font.name = "Arial"
    d.styles["Normal"].font.size = Pt(10)
    return d


def bilag2() -> None:
    d = docx_doc()
    d.add_heading("Bilag 2 Evaluering og tildeling", level=0)
    d.add_paragraph(f"{PROJECT} · {CUSTOMER} · Saksnr. 2026/1184")
    d.add_heading("1 Tildelingskriterier og vekter", level=1)
    d.add_paragraph("Kontrakten tildeles leverandøren med det tilbudet som har beste forhold mellom pris og kvalitet, vurdert etter kriteriene i tabellen under. Vektene summerer seg til 100 %.")
    table = d.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    for cell, label in zip(table.rows[0].cells, ["Tildelingskriterium", "Vekt", "Dokumentasjon og vurdering"]):
        cell.text = label
    for name, weight, desc in CRITERIA:
        row = table.add_row().cells
        row[0].text, row[1].text, row[2].text = name, weight, desc
    d.add_heading("2 Evalueringsmodell", level=1)
    d.add_paragraph("Hvert kriterium gis poeng fra 0 til 10. Pris evalueres etter en lineær modell: Laveste evaluerte pris gis 10 poeng. Øvrige tilbud gis poeng etter formelen Poeng = 10 − ((Tilbudt pris − Laveste pris) / Laveste pris) × 10. Negative poeng settes til 0.")
    d.add_paragraph("For kvalitet, gjennomføring og miljø gis 10 poeng til den besvarelsen som best oppfyller kommunens behov. Øvrige besvarelser gis poeng relativt til denne. Vektet poengsum beregnes som summen av poeng multiplisert med vekt.")
    d.add_heading("3 Avvisning og forbehold", level=1)
    d.add_paragraph("Tilbud som ikke oppfyller ett eller flere minstekrav (skal-krav) i Bilag 1, vil bli avvist. Bør-krav er ikke absolutte, men manglende eller svak oppfyllelse gir lavere poeng på det aktuelle tildelingskriteriet.")
    d.save(OUT / "03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx")


# --------------------------------------------------------------------------
# 04 Løsningsnotat fra leverandør (primary_solution_document, DOCX)
# --------------------------------------------------------------------------

SOLUTION_PARAGRAPHS = [
    ("Plattform og dataplassering", "Atea tilbyr drift på Microsoft Azure i regionene Norway East (Oslo) og Norway West (Stavanger). Alle kundedata, sikkerhetskopier og logger lagres i Norge. Avstanden mellom regionene er over 300 km. Lagring i Norge inngår i fastprisen."),
    ("Sertifisering og personell", "Atea er sertifisert etter ISO/IEC 27001:2022 (sertifikat nr. NO-ISMS-48211, gyldig til 2028). Kundeansvarlig er Ingrid Sæther og teknisk kontaktperson er Bjørn Østvik; begge er norskspråklige. Alt driftspersonell leverer politiattest ved tiltredelse. Fast team: fire navngitte driftsressurser, hvorav to har Azure Solutions Architect Expert."),
    ("Referanser", "Atea kan vise til to relevante referanseprosjekter fra de siste fem årene: Vestre Lia kommune (1 400 brukere) og Søre Bø interkommunale IKT (900 brukere)."),
    ("Driftssenter", "Atea driftssenter i Oslo er bemannet døgnet rundt alle dager, med reservesenter i Kraków (Polen)."),
    ("Tjenestenivå og gjenoppretting", "Tilgjengelighet for kritiske fagsystemer: 99,8 % per måned i tidsrommet 06:00–22:00. Gjenopprettingstid for kritiske fagsystemer er 4 timer (RTO), og maksimalt datatap er 15 minutter (RPO). Månedlig tjenestenivårapport med trendanalyse leveres innen femte virkedag."),
    ("Hendelseshåndtering", "Kritiske hendelser besvares innen 15 minutter døgnet rundt, og kommunens IT-vakt varsles på telefon innen 30 minutter. Forbehold: Atea har ikke lokal tilstedeværelse i Hålandsvik. Fysisk oppmøte på rådhuset kan tilbys innen 4 timer på hverdager kl. 07:00–17:00; utenom dette tidsrommet er oppmøtetiden inntil 8 timer. Årlig beredskapsøvelse med full gjenoppretting av ett fagsystem inngår."),
    ("Nettverk", "Atea etablerer IPsec VPN med 1 Gbit/s mellom rådhuset og Azure, og all administrativ tilgang skjer med flerfaktorautentisering via et separat administrasjonsnett. IPv6 er ikke planlagt i kontraktsperioden."),
    ("Kryptering og personvern", "Data krypteres med plattformstyrte nøkler. Kundestyrte nøkler (Azure Key Vault Managed HSM) inngår ikke i fastprisen og prises som tilleggsopsjon. Atea signerer kommunens databehandleravtale og varsler sikkerhetsbrudd innen 24 timer."),
    ("Energi", "Microsofts datasentre i Norge drives med 100 % fornybar energi, dokumentert med opprinnelsesgarantier."),
    ("Overgang og exit", "Exitplan med dataeksport i åpne formater, tidsplan og ansvarsfordeling leveres innen 3 måneder etter kontraktsinngåelse. Migreringen gjennomføres i helgevinduer, slik at kritiske fagsystemer ikke har nedetid i kommunens åpningstid."),
]


def solution_note() -> None:
    d = docx_doc()
    d.add_heading("Løsningsnotat – Atea, utkast til tilbud til Hålandsvik kommune", level=0)
    d.add_paragraph("Internt arbeidsdokument for tilbudsteamet. Grunnlag for kravsvar til Bilag 1.")
    for heading, text in SOLUTION_PARAGRAPHS:
        d.add_heading(heading, level=1)
        d.add_paragraph(text)
    d.save(OUT / "04_Losningsnotat_Atea_Halandsvik.docx")


def pages_of(pdf: Path) -> list[str]:
    return [p.extract_text() or "" for p in PdfReader(str(pdf)).pages]


if __name__ == "__main__":
    main_document()
    bilag1()
    bilag2()
    solution_note()
    pages = {name: pages_of(OUT / name) for name in [
        "01_Konkurransegrunnlag_Halandsvik_kommune.pdf",
        "02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf"]}
    (OUT.parent / "authoring").mkdir(exist_ok=True)
    (OUT.parent / "authoring" / "pypdf_pages.json").write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT.parent / "authoring" / "source_data.json").write_text(json.dumps({
        "requirements": REQUIREMENTS, "distractor": DISTRACTOR, "qualification": QUALIFICATION,
        "timeline": TIMELINE, "value_rows": VALUE_ROWS, "criteria": CRITERIA,
        "solution": SOLUTION_PARAGRAPHS}, ensure_ascii=False, indent=2), encoding="utf-8")
    for name, texts in pages.items():
        print(name, "pages:", len(texts))

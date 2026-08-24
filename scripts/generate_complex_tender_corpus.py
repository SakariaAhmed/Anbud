from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable
from xml.sax.saxutils import escape

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
SOURCE_PATH = (
    REPOSITORY_ROOT / "test-data" / "complex-tender-corpus" / "scenarios.json"
)
OUTPUT_DIR = REPOSITORY_ROOT / "output" / "pdf" / "complex-tender-corpus"

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = 18 * mm
RIGHT_MARGIN = 18 * mm
TOP_MARGIN = 20 * mm
BOTTOM_MARGIN = 18 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

INK = colors.HexColor("#1A2633")
NAVY = colors.HexColor("#12324A")
BLUE = colors.HexColor("#245B78")
TEAL = colors.HexColor("#187977")
LIGHT_BLUE = colors.HexColor("#EAF2F7")
LIGHT_TEAL = colors.HexColor("#E7F4F2")
LIGHT_GREY = colors.HexColor("#F3F5F7")
MID_GREY = colors.HexColor("#64727D")
LINE = colors.HexColor("#C8D2D9")
WHITE = colors.white
RISK = colors.HexColor("#9B2C2C")


def register_fonts() -> tuple[str, str]:
    candidates = [
        (
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
            Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("TenderSans", str(regular)))
            pdfmetrics.registerFont(TTFont("TenderSans-Bold", str(bold)))
            return "TenderSans", "TenderSans-Bold"
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = register_fonts()


def make_styles() -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    return {
        "body": ParagraphStyle(
            "TenderBody",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=9.6,
            leading=13.2,
            textColor=INK,
            spaceAfter=6,
        ),
        "small": ParagraphStyle(
            "TenderSmall",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=8,
            leading=10.5,
            textColor=INK,
        ),
        "tiny": ParagraphStyle(
            "TenderTiny",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=7.25,
            leading=9.25,
            textColor=INK,
        ),
        "table_header": ParagraphStyle(
            "TenderTableHeader",
            parent=sample["BodyText"],
            fontName=FONT_BOLD,
            fontSize=7.4,
            leading=9,
            textColor=WHITE,
            alignment=TA_LEFT,
        ),
        "kicker": ParagraphStyle(
            "TenderKicker",
            parent=sample["BodyText"],
            fontName=FONT_BOLD,
            fontSize=9,
            leading=11,
            textColor=TEAL,
            spaceAfter=7,
            uppercase=True,
        ),
        "title": ParagraphStyle(
            "TenderTitle",
            parent=sample["Title"],
            fontName=FONT_BOLD,
            fontSize=24,
            leading=28,
            textColor=NAVY,
            alignment=TA_LEFT,
            spaceAfter=12,
        ),
        "subtitle": ParagraphStyle(
            "TenderSubtitle",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=12,
            leading=16,
            textColor=MID_GREY,
            spaceAfter=20,
        ),
        "h1": ParagraphStyle(
            "TenderH1",
            parent=sample["Heading1"],
            fontName=FONT_BOLD,
            fontSize=15,
            leading=18,
            textColor=NAVY,
            spaceBefore=11,
            spaceAfter=7,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "TenderH2",
            parent=sample["Heading2"],
            fontName=FONT_BOLD,
            fontSize=11.5,
            leading=14,
            textColor=BLUE,
            spaceBefore=9,
            spaceAfter=5,
            keepWithNext=True,
        ),
        "bullet": ParagraphStyle(
            "TenderBullet",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=9.4,
            leading=12.8,
            textColor=INK,
            leftIndent=13,
            firstLineIndent=-8,
            bulletIndent=0,
            spaceAfter=4,
        ),
        "callout": ParagraphStyle(
            "TenderCallout",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=9.2,
            leading=12.6,
            textColor=INK,
        ),
        "cover_meta": ParagraphStyle(
            "TenderCoverMeta",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=9.2,
            leading=12,
            textColor=INK,
        ),
        "answer": ParagraphStyle(
            "TenderAnswer",
            parent=sample["BodyText"],
            fontName=FONT,
            fontSize=7.15,
            leading=9.3,
            textColor=INK,
        ),
    }


STYLES = make_styles()


def paragraph(text: str, style: str = "body") -> Paragraph:
    return Paragraph(escape(text), STYLES[style])


def rich_paragraph(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, STYLES[style])


def bullets(items: Iterable[str]) -> list[Paragraph]:
    return [
        Paragraph(f"<bullet>&#8226;</bullet>{escape(item)}", STYLES["bullet"])
        for item in items
    ]


def callout(label: str, text: str, *, risk: bool = False) -> Table:
    fill = colors.HexColor("#FCEEEE") if risk else LIGHT_TEAL
    label_color = RISK if risk else TEAL
    content = rich_paragraph(
        f'<font name="{FONT_BOLD}" color="{label_color.hexval()}">'
        f"{escape(label)}</font><br/>{escape(text)}",
        "callout",
    )
    table = Table([[content]], colWidths=[CONTENT_WIDTH - 8], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), fill),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def cover_story(
    scenario: dict[str, Any],
    document_label: str,
    title: str,
    status: str,
) -> list[Any]:
    metadata = [
        ["Kunde", scenario["customer"]],
        ["Anskaffelse", scenario["procurement"]],
        ["Kontraktsmønster", scenario["contract"]],
        ["Dokumentdato", scenario["document_date"]],
        ["Status", status],
    ]
    metadata_table = Table(
        [
            [
                rich_paragraph(
                    f'<font name="{FONT_BOLD}">{escape(label)}</font>',
                    "cover_meta",
                ),
                paragraph(value, "cover_meta"),
            ]
            for label, value in metadata
        ],
        colWidths=[42 * mm, CONTENT_WIDTH - 42 * mm],
        hAlign="LEFT",
    )
    metadata_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), LIGHT_BLUE),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return [
        Spacer(1, 14 * mm),
        paragraph(document_label.upper(), "kicker"),
        paragraph(title, "title"),
        paragraph(scenario["project_name"], "subtitle"),
        metadata_table,
        Spacer(1, 10 * mm),
        callout(
            "Fiktivt testgrunnlag",
            "Alle virksomheter, leverandører, tall og avtaler i dokumentet er fiktive. "
            "Dokumentet er konstruert for funksjons-, parser- og kvalitetsprøving.",
        ),
        PageBreak(),
    ]


def requirements_table(
    requirements: list[dict[str, Any]], *, include_answer: bool
) -> LongTable:
    if include_answer:
        rows: list[list[Any]] = [
            [
                paragraph("Krav-ID", "table_header"),
                paragraph("Pri.", "table_header"),
                paragraph("Kundens krav", "table_header"),
                paragraph("Leverandørens bindende svar", "table_header"),
            ]
        ]
        for requirement in requirements:
            rows.append(
                [
                    rich_paragraph(
                        f'<font name="{FONT_BOLD}">{escape(requirement["id"])}</font>',
                        "tiny",
                    ),
                    paragraph(requirement["priority"], "tiny"),
                    rich_paragraph(
                        f'<font name="{FONT_BOLD}">{escape(requirement["topic"])}</font><br/>'
                        f'{escape(requirement["text"])}',
                        "answer",
                    ),
                    paragraph(requirement["answer"], "answer"),
                ]
            )
        widths = [25 * mm, 11 * mm, 58 * mm, CONTENT_WIDTH - 94 * mm]
    else:
        rows = [
            [
                paragraph("Krav-ID", "table_header"),
                paragraph("Pri.", "table_header"),
                paragraph("Tema", "table_header"),
                paragraph("Krav som Leverandøren skal besvare", "table_header"),
            ]
        ]
        for requirement in requirements:
            rows.append(
                [
                    rich_paragraph(
                        f'<font name="{FONT_BOLD}">{escape(requirement["id"])}</font>',
                        "small",
                    ),
                    paragraph(requirement["priority"], "small"),
                    paragraph(requirement["topic"], "small"),
                    paragraph(requirement["text"], "small"),
                ]
            )
        widths = [27 * mm, 12 * mm, 36 * mm, CONTENT_WIDTH - 75 * mm]

    table = LongTable(
        rows,
        colWidths=widths,
        repeatRows=1,
        splitByRow=True,
        hAlign="LEFT",
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (1, 1), (1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def section(story: list[Any], title: str, paragraphs: Iterable[str]) -> None:
    story.append(paragraph(title, "h1"))
    story.extend(paragraph(item) for item in paragraphs)


def bilag_1_story(scenario: dict[str, Any]) -> list[Any]:
    story = cover_story(
        scenario,
        "Bilag 1",
        "Kundens behov og krav",
        "Konkurransegrunnlag - fiktiv testversjon",
    )
    section(story, "1. Virksomhet og anskaffelsesbehov", scenario["background"])
    story.append(
        callout(
            "Formål",
            "Kunden ønsker en løsning som gir målbar virksomhetseffekt uten å "
            "svekke sikkerhet, sporbarhet, dataeierskap eller operativ kontinuitet.",
        )
    )
    story.append(paragraph("2. Mål og forventede effekter", "h1"))
    story.extend(bullets(scenario["goals"]))
    story.append(paragraph("3. Føringer og avgrensninger", "h1"))
    story.extend(bullets(scenario["constraints"]))
    story.append(paragraph("4. Tildelingsmodell", "h1"))
    story.extend(bullets(scenario["evaluation"]))
    story.append(
        callout(
            "Prioritetsnøkkel",
            "A er et absolutt krav. B er et evaluert kvalitetskrav. "
            "C er en opsjon eller et ønsket tillegg. Avvik skal oppgis eksplisitt.",
        )
    )
    story.append(paragraph("5. Kravmatrise", "h1"))
    story.append(
        paragraph(
            "Leverandøren skal gjengi krav-ID uendret i Bilag 2 og beskrive "
            "oppfyllelse, forutsetninger, verifikasjon og eventuelle avvik."
        )
    )
    story.append(requirements_table(scenario["requirements"], include_answer=False))
    story.append(paragraph("6. Forhold som skal avklares", "h1"))
    story.extend(bullets(scenario["ambiguities"]))
    story.append(
        callout(
            "Viktig",
            "Åpne forhold er ikke tillatelse til å dikte kundebeslutninger. "
            "Tilbudet skal beskrive en trygg basis, konsekvens og beslutningspunkt.",
            risk=True,
        )
    )
    return story


def bilag_2_story(scenario: dict[str, Any]) -> list[Any]:
    good = scenario["good_solution"]
    story = cover_story(
        scenario,
        "Bilag 2",
        "Leverandørens beskrivelse av løsningen",
        f"Tilbudsbesvarelse fra {scenario['supplier']} - fiktiv testversjon",
    )
    story.append(paragraph("1. Tilbudt løsning", "h1"))
    story.append(
        rich_paragraph(
            f'<font name="{FONT_BOLD}">{escape(scenario["solution_name"])}</font> '
            f'{escape(good["summary"])}'
        )
    )
    story.append(
        callout(
            "Leverandørens hovedforpliktelse",
            "Løsningen leveres med dokumenterte akseptansekriterier, sporbare "
            "forutsetninger og en tilbakefallsplan for hver risikoutsatt overgang.",
        )
    )
    story.append(paragraph("2. Målarkitektur", "h1"))
    story.extend(bullets(good["architecture"]))
    story.append(paragraph("3. Gjennomføring og verifikasjon", "h1"))
    story.extend(bullets(good["delivery"]))
    story.append(paragraph("4. Krav-for-krav-besvarelse", "h1"))
    story.append(
        paragraph(
            "Alle A-krav bekreftes oppfylt med mindre annet er angitt. "
            "Svarene nedenfor er bindende del av den fiktive tilbudsbesvarelsen."
        )
    )
    story.append(requirements_table(scenario["requirements"], include_answer=True))
    story.append(paragraph("5. Posisjonering og dokumentert verdi", "h1"))
    story.extend(bullets(good["win_themes"]))
    story.append(paragraph("6. Forutsetninger og leveranserisiko", "h1"))
    story.extend(bullets(good["key_risks"]))
    story.append(
        callout(
            "Ingen skjulte avvik",
            "De åpne forholdene i Bilag 1 håndteres som beslutningspunkter. "
            "Leverandøren har ikke lagt uavklarte opsjoner til grunn for at "
            "basisløsningen skal fungere.",
            risk=True,
        )
    )
    return story


class TenderDocument(BaseDocTemplate):
    def __init__(
        self,
        output_path: Path,
        *,
        title: str,
        document_label: str,
        customer: str,
    ) -> None:
        super().__init__(
            str(output_path),
            pagesize=A4,
            leftMargin=LEFT_MARGIN,
            rightMargin=RIGHT_MARGIN,
            topMargin=TOP_MARGIN,
            bottomMargin=BOTTOM_MARGIN,
            title=title,
            author=customer,
            subject="Fiktivt testgrunnlag for anbudsapp",
            creator="Codex testkorpusgenerator",
        )
        frame = Frame(
            LEFT_MARGIN,
            BOTTOM_MARGIN,
            CONTENT_WIDTH,
            PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
            id="normal",
        )
        self.addPageTemplates(
            [
                PageTemplate(
                    id="tender",
                    frames=[frame],
                    onPage=self._header_footer,
                )
            ]
        )
        self.document_label = document_label
        self.customer = customer

    def _header_footer(self, canvas, document) -> None:
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.4)
        canvas.line(
            LEFT_MARGIN,
            PAGE_HEIGHT - 13 * mm,
            PAGE_WIDTH - RIGHT_MARGIN,
            PAGE_HEIGHT - 13 * mm,
        )
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MID_GREY)
        canvas.drawString(
            LEFT_MARGIN,
            PAGE_HEIGHT - 10 * mm,
            f"{self.document_label} | {self.customer}",
        )
        canvas.drawRightString(
            PAGE_WIDTH - RIGHT_MARGIN,
            9 * mm,
            f"Fiktivt testgrunnlag | Side {document.page}",
        )
        canvas.restoreState()


def build_pdf(
    output_path: Path,
    scenario: dict[str, Any],
    *,
    document_label: str,
    story: list[Any],
) -> None:
    document = TenderDocument(
        output_path,
        title=f"{document_label} - {scenario['project_name']}",
        document_label=document_label,
        customer=scenario["customer"],
    )
    document.build(story)


def plain_text(scenario: dict[str, Any], *, include_answer: bool) -> str:
    label = "BILAG 2 - LEVERANDØRENS LØSNING" if include_answer else "BILAG 1 - KUNDENS BEHOV OG KRAV"
    lines = [
        label,
        scenario["project_name"],
        f"Kunde: {scenario['customer']}",
        f"Anskaffelse: {scenario['procurement']}",
        f"Kontrakt: {scenario['contract']}",
        "Fiktivt testgrunnlag: Alle virksomheter, leverandører, tall og avtaler i dokumentet er fiktive.",
        "",
        "VIRKSOMHET OG ANSKAFFELSESBEHOV",
        *scenario["background"],
        "",
        "MÅL OG FORVENTEDE EFFEKTER",
        *scenario["goals"],
        "",
        "FØRINGER OG AVGRENSNINGER",
        *scenario["constraints"],
        "",
        "TILDELINGSMODELL",
        *scenario["evaluation"],
        "",
    ]
    if include_answer:
        good = scenario["good_solution"]
        lines.extend(
            [
                f"TILBUDT LØSNING: {scenario['solution_name']}",
                good["summary"],
                "",
                "MÅLARKITEKTUR",
                *good["architecture"],
                "",
                "GJENNOMFØRING",
                *good["delivery"],
                "",
            ]
        )
    lines.append("KRAVMATRISE")
    for requirement in scenario["requirements"]:
        lines.extend(
            [
                f"{requirement['id']} | Prioritet {requirement['priority']} | {requirement['topic']}",
                requirement["text"],
            ]
        )
        if include_answer:
            lines.append(f"Leverandørens svar: {requirement['answer']}")
        lines.append("")
    lines.extend(["FORHOLD SOM SKAL AVKLARES", *scenario["ambiguities"]])
    if include_answer:
        lines.extend(
            [
                "",
                "POSISJONERING OG VERDI",
                *scenario["good_solution"]["win_themes"],
                "",
                "FORUTSETNINGER OG RISIKO",
                *scenario["good_solution"]["key_risks"],
            ]
        )
    return "\n".join(lines).strip() + "\n"


def answer_key_markdown(scenario: dict[str, Any]) -> str:
    good = scenario["good_solution"]

    def list_items(values: list[str]) -> str:
        return "\n".join(f"- {value}" for value in values)

    must_cover = "\n".join(
        f"- `{item['id']}`: "
        + "; ".join(" / ".join(group) for group in item["required_term_groups"])
        for item in scenario["answer_key"]["must_cover"]
    )
    requirements = "\n".join(
        f"- `{requirement['id']}` ({requirement['priority']}): {requirement['answer']}"
        for requirement in scenario["requirements"]
    )
    return f"""# Fasit - {scenario["project_name"]}

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

{good["summary"]}

## Målarkitektur

{list_items(good["architecture"])}

## Gjennomføring og akseptanse

{list_items(good["delivery"])}

## Vinnende tilbudstemaer

{list_items(good["win_themes"])}

## Viktigste risikoer

{list_items(good["key_risks"])}

## Fakta kundeanalysen må fange

{must_cover}

## Påstander analysen ikke må gjøre

{list_items(scenario["answer_key"]["must_not_claim"])}

## Krav-for-krav forventet god besvarelse

{requirements}
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    source = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
    scenarios = source["scenarios"]
    if len(scenarios) != 5:
        raise ValueError(f"Testkorpuset skal ha nøyaktig fem scenarioer, fant {len(scenarios)}.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_documents: list[dict[str, Any]] = []
    corpus_answer_keys: list[dict[str, Any]] = []

    for scenario in scenarios:
        slug = scenario["id"]
        bilag_1_pdf = OUTPUT_DIR / f"{slug}_bilag1.pdf"
        bilag_2_pdf = OUTPUT_DIR / f"{slug}_bilag2.pdf"
        bilag_1_txt = OUTPUT_DIR / f"{slug}_bilag1.txt"
        bilag_2_txt = OUTPUT_DIR / f"{slug}_bilag2.txt"
        answer_json = OUTPUT_DIR / f"{slug}_fasit.json"
        answer_md = OUTPUT_DIR / f"{slug}_fasit.md"

        build_pdf(
            bilag_1_pdf,
            scenario,
            document_label="Bilag 1",
            story=bilag_1_story(scenario),
        )
        build_pdf(
            bilag_2_pdf,
            scenario,
            document_label="Bilag 2",
            story=bilag_2_story(scenario),
        )
        bilag_1_txt.write_text(
            plain_text(scenario, include_answer=False), encoding="utf-8"
        )
        bilag_2_txt.write_text(
            plain_text(scenario, include_answer=True), encoding="utf-8"
        )
        answer_payload = {
            "scenario_id": slug,
            "project_name": scenario["project_name"],
            "good_solution": scenario["good_solution"],
            "answer_key": scenario["answer_key"],
            "requirements": scenario["requirements"],
        }
        answer_json.write_text(
            json.dumps(answer_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        answer_md.write_text(answer_key_markdown(scenario), encoding="utf-8")
        corpus_answer_keys.append(answer_payload)

        for role, path in [
            ("primary_customer_document", bilag_1_pdf),
            ("primary_solution_document", bilag_2_pdf),
        ]:
            reader = PdfReader(str(path))
            manifest_documents.append(
                {
                    "scenario_id": slug,
                    "project_name": scenario["project_name"],
                    "role": role,
                    "filename": path.name,
                    "text_filename": path.with_suffix(".txt").name,
                    "pages": len(reader.pages),
                    "bytes": path.stat().st_size,
                    "sha256": sha256(path),
                }
            )

    (OUTPUT_DIR / "answer-keys.json").write_text(
        json.dumps(corpus_answer_keys, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "corpus": "complex-tender-corpus",
        "fictional": True,
        "scenario_count": len(scenarios),
        "document_count": len(manifest_documents),
        "generated_at": "2026-07-30",
        "source": str(SOURCE_PATH.relative_to(REPOSITORY_ROOT)),
        "documents": manifest_documents,
    }
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output_dir": str(OUTPUT_DIR),
                "scenarios": len(scenarios),
                "pdfs": len(manifest_documents),
                "answer_keys": len(corpus_answer_keys),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate the deterministic Document Analysis v3 stress corpus PDFs."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = (
    REPOSITORY_ROOT / "test-data" / "document-analysis-stress" / "corpus.json"
)
OUTPUT_DIR = (
    REPOSITORY_ROOT / "output" / "pdf" / "document-analysis-stress"
)
ANSWER_KEY_PATH = OUTPUT_DIR / "document-analysis-stress-answer-key.pdf"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"

PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN_X = 16 * mm
HEADER_Y = PAGE_HEIGHT - 14 * mm
CONTENT_TOP = PAGE_HEIGHT - 25 * mm
CONTENT_BOTTOM = 17 * mm
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X
GAP = 6 * mm
COLUMN_WIDTH = (CONTENT_WIDTH - GAP) / 2

INK = colors.HexColor("#17241f")
MUTED = colors.HexColor("#5c6863")
GREEN = colors.HexColor("#2f5d50")
LINE = colors.HexColor("#c8d0cc")
PAPER = colors.HexColor("#fbfaf5")

BLOCK_COLORS = {
    "cover": colors.HexColor("#e7eee9"),
    "memo": colors.HexColor("#f2f4f0"),
    "email": colors.HexColor("#eef3f6"),
    "note": colors.HexColor("#fff4ce"),
    "paragraph": colors.HexColor("#fbfaf5"),
    "pseudo_table": colors.HexColor("#f4f0e8"),
}


def load_corpus() -> dict[str, Any]:
    with CORPUS_PATH.open("r", encoding="utf-8") as handle:
        corpus = json.load(handle)
    if len(corpus.get("documents", [])) != 5:
        raise ValueError("Stress corpus must contain exactly five documents.")
    serialized = json.dumps(corpus, ensure_ascii=False)
    forbidden_dashes = {
        "\u2010": "hyphen",
        "\u2011": "non-breaking hyphen",
        "\u2012": "figure dash",
        "\u2013": "en dash",
        "\u2014": "em dash",
    }
    for character, label in forbidden_dashes.items():
        if character in serialized:
            raise ValueError(f"Corpus contains forbidden {label}; use ASCII hyphen.")
    return corpus


def paragraph_style(
    name: str,
    *,
    font_name: str = "Helvetica",
    font_size: float = 8.5,
    leading: float = 11.2,
    text_color: colors.Color = INK,
    space_after: float = 0,
) -> ParagraphStyle:
    return ParagraphStyle(
        name,
        fontName=font_name,
        fontSize=font_size,
        leading=leading,
        textColor=text_color,
        alignment=TA_LEFT,
        spaceAfter=space_after,
        allowWidows=0,
        allowOrphans=0,
    )


BODY_STYLE = paragraph_style("body")
LABEL_STYLE = paragraph_style(
    "label",
    font_name="Helvetica-Bold",
    font_size=7.1,
    leading=8.5,
    text_color=GREEN,
)
COVER_STYLE = paragraph_style(
    "cover",
    font_name="Helvetica-Bold",
    font_size=12.5,
    leading=15.5,
)
TABLE_STYLE = paragraph_style("table", font_size=7.7, leading=9.5)


def escape_text(value: Any) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


def draw_header(
    pdf: canvas.Canvas,
    document: dict[str, Any],
    page_number: int,
) -> None:
    pdf.saveState()
    pdf.setFillColor(PAPER)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    pdf.setFillColor(GREEN)
    pdf.setFont("Helvetica-Bold", 7.4)
    pdf.drawString(MARGIN_X, HEADER_Y, document["client"])
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 7)
    right_text = f"Arbeidsdokument / side {page_number}"
    pdf.drawRightString(PAGE_WIDTH - MARGIN_X, HEADER_Y, right_text)
    pdf.setStrokeColor(LINE)
    pdf.setLineWidth(0.5)
    pdf.line(MARGIN_X, HEADER_Y - 3 * mm, PAGE_WIDTH - MARGIN_X, HEADER_Y - 3 * mm)
    pdf.setFont("Helvetica", 6.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(
        MARGIN_X,
        9 * mm,
        "Fiktivt evalueringsdokument - Document Analysis v3",
    )
    pdf.drawRightString(
        PAGE_WIDTH - MARGIN_X,
        9 * mm,
        document["id"],
    )
    pdf.restoreState()


def block_height(block: dict[str, Any], width: float) -> float:
    padding = 4 * mm
    label = Paragraph(escape_text(block.get("label", "")), LABEL_STYLE)
    _, label_height = label.wrap(width - 2 * padding, PAGE_HEIGHT)
    if block["type"] == "pseudo_table":
        rows = [
            [
                Paragraph(escape_text(row[0]), TABLE_STYLE),
                Paragraph(escape_text(row[1]), TABLE_STYLE),
            ]
            for row in block["rows"]
        ]
        table = Table(rows, colWidths=[(width - 2 * padding) * 0.64, (width - 2 * padding) * 0.36])
        table.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eef0eb")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 3),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                    ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                ]
            )
        )
        _, table_height = table.wrap(width - 2 * padding, PAGE_HEIGHT)
        return padding + label_height + 2 * mm + table_height + padding
    style = COVER_STYLE if block["type"] == "cover" else BODY_STYLE
    body = Paragraph(escape_text(block.get("text", "")), style)
    _, body_height = body.wrap(width - 2 * padding, PAGE_HEIGHT)
    return padding + label_height + 1.5 * mm + body_height + padding


def draw_block(
    pdf: canvas.Canvas,
    block: dict[str, Any],
    x: float,
    y_top: float,
    width: float,
) -> float:
    height = block_height(block, width)
    y_bottom = y_top - height
    padding = 4 * mm
    pdf.saveState()
    pdf.setFillColor(BLOCK_COLORS[block["type"]])
    pdf.setStrokeColor(LINE)
    pdf.setLineWidth(0.45)
    pdf.roundRect(x, y_bottom, width, height, 2.4 * mm, fill=1, stroke=1)
    label = Paragraph(escape_text(block.get("label", "")), LABEL_STYLE)
    _, label_height = label.wrap(width - 2 * padding, height)
    label.drawOn(pdf, x + padding, y_top - padding - label_height)
    body_top = y_top - padding - label_height - 1.5 * mm
    if block["type"] == "pseudo_table":
        rows = [
            [
                Paragraph(escape_text(row[0]), TABLE_STYLE),
                Paragraph(escape_text(row[1]), TABLE_STYLE),
            ]
            for row in block["rows"]
        ]
        table = Table(
            rows,
            colWidths=[(width - 2 * padding) * 0.64, (width - 2 * padding) * 0.36],
        )
        table.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eef0eb")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 3),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                    ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                ]
            )
        )
        _, table_height = table.wrap(width - 2 * padding, height)
        table.drawOn(pdf, x + padding, body_top - table_height)
    else:
        style = COVER_STYLE if block["type"] == "cover" else BODY_STYLE
        body = Paragraph(escape_text(block.get("text", "")), style)
        _, body_height = body.wrap(width - 2 * padding, height)
        body.drawOn(pdf, x + padding, body_top - body_height)
    pdf.restoreState()
    return y_bottom - 3 * mm


def render_document(document: dict[str, Any], output_path: Path) -> int:
    pdf = canvas.Canvas(str(output_path), pagesize=A4)
    page_number = 0

    def start_page() -> None:
        nonlocal page_number
        page_number += 1
        draw_header(pdf, document, page_number)

    for page in document["pages"]:
        start_page()
        layout = page["layout"]
        blocks = page["blocks"]
        if layout == "full":
            y = CONTENT_TOP
            for block in blocks:
                required = block_height(block, CONTENT_WIDTH)
                if y - required < CONTENT_BOTTOM:
                    pdf.showPage()
                    start_page()
                    y = CONTENT_TOP
                y = draw_block(pdf, block, MARGIN_X, y, CONTENT_WIDTH)
        else:
            left_y = CONTENT_TOP
            right_y = CONTENT_TOP
            for block in blocks:
                wide = block["type"] in {"cover", "pseudo_table"} and layout == "mixed"
                if wide:
                    y = min(left_y, right_y)
                    required = block_height(block, CONTENT_WIDTH)
                    if y - required < CONTENT_BOTTOM:
                        pdf.showPage()
                        start_page()
                        y = CONTENT_TOP
                    next_y = draw_block(pdf, block, MARGIN_X, y, CONTENT_WIDTH)
                    left_y = next_y
                    right_y = next_y
                    continue
                use_left = left_y >= right_y
                x = MARGIN_X if use_left else MARGIN_X + COLUMN_WIDTH + GAP
                y = left_y if use_left else right_y
                required = block_height(block, COLUMN_WIDTH)
                if y - required < CONTENT_BOTTOM:
                    other_y = right_y if use_left else left_y
                    if other_y - required >= CONTENT_BOTTOM:
                        use_left = not use_left
                        x = MARGIN_X if use_left else MARGIN_X + COLUMN_WIDTH + GAP
                        y = left_y if use_left else right_y
                    else:
                        pdf.showPage()
                        start_page()
                        left_y = CONTENT_TOP
                        right_y = CONTENT_TOP
                        use_left = True
                        x = MARGIN_X
                        y = CONTENT_TOP
                next_y = draw_block(pdf, block, x, y, COLUMN_WIDTH)
                if use_left:
                    left_y = next_y
                else:
                    right_y = next_y
        pdf.showPage()
    pdf.save()
    return page_number


def answer_key_story(corpus: dict[str, Any]) -> list[Any]:
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "AnswerTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=27,
        textColor=INK,
        spaceAfter=14,
    )
    subtitle = ParagraphStyle(
        "AnswerSubtitle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=11,
        textColor=MUTED,
        spaceAfter=8,
    )
    h1 = ParagraphStyle(
        "AnswerH1",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=13.5,
        leading=16,
        textColor=GREEN,
        spaceBefore=7,
        spaceAfter=7,
    )
    h2 = ParagraphStyle(
        "AnswerH2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=11,
        textColor=INK,
        spaceBefore=6,
        spaceAfter=4,
    )
    body = ParagraphStyle(
        "AnswerBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=7.2,
        leading=9.2,
        textColor=INK,
        leftIndent=8,
        firstLineIndent=-8,
        spaceAfter=3,
    )
    story: list[Any] = [
        Paragraph("Fasit - Document Analysis v3 stresskorpus", title),
        Paragraph(
            "Manuelt forfattet fasit for fem fiktive klientdokumenter. "
            "Fasiten skal aldri inngå i modellens analysekontekst. Den brukes "
            "bare etter generering til deterministisk dekning og uavhengig vurdering.",
            subtitle,
        ),
        Paragraph(
            f"Versjon: {escape_text(corpus['version'])} | Dato: {escape_text(corpus['generated_at'])}",
            subtitle,
        ),
        PageBreak(),
    ]
    category_labels = {
        "profile": "Kundeprofil og nåsituasjon",
        "goals": "Mål og effekter",
        "requirements": "Eksplisitte krav",
        "deadlines": "Frister og leveranser",
        "commercial": "Kommersielle vilkår",
        "evaluation": "Evaluering",
        "risks": "Risiko",
        "ambiguities": "Avklaringer",
        "solution_direction": "Forventet løsningsretning",
    }
    for index, document in enumerate(corpus["documents"]):
        if index:
            story.append(PageBreak())
        story.extend(
            [
                Paragraph(
                    f"{index + 1}. {escape_text(document['client'])}",
                    h1,
                ),
                Paragraph(
                    f"{escape_text(document['title'])}<br/>Sektor: {escape_text(document['sector'])}",
                    subtitle,
                ),
            ]
        )
        answer_key = document["answer_key"]
        for category, label in category_labels.items():
            story.append(Paragraph(label, h2))
            for fact in answer_key[category]:
                story.append(
                    Paragraph(
                        f"<b>{escape_text(fact['id'])}:</b> {escape_text(fact['statement'])}",
                        body,
                    )
                )
        story.append(Paragraph("Påstander som ikke skal fremsettes", h2))
        for claim in answer_key["must_not_claim"]:
            story.append(Paragraph(f"- {escape_text(claim)}", body))
        story.append(Spacer(1, 5 * mm))
    return story


def render_answer_key(corpus: dict[str, Any]) -> None:
    def page_furniture(pdf: canvas.Canvas, document: SimpleDocTemplate) -> None:
        pdf.saveState()
        pdf.setStrokeColor(LINE)
        pdf.setLineWidth(0.5)
        pdf.line(18 * mm, PAGE_HEIGHT - 13 * mm, PAGE_WIDTH - 18 * mm, PAGE_HEIGHT - 13 * mm)
        pdf.setFont("Helvetica-Bold", 7)
        pdf.setFillColor(GREEN)
        pdf.drawString(18 * mm, PAGE_HEIGHT - 10 * mm, "Document Analysis v3 - fasit")
        pdf.setFont("Helvetica", 6.5)
        pdf.setFillColor(MUTED)
        pdf.drawString(18 * mm, 9 * mm, "Holdt utenfor modellkontekst")
        pdf.drawRightString(
            PAGE_WIDTH - 18 * mm,
            9 * mm,
            f"Side {document.page}",
        )
        pdf.restoreState()

    document = SimpleDocTemplate(
        str(ANSWER_KEY_PATH),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=17 * mm,
        bottomMargin=16 * mm,
        title="Fasit - Document Analysis v3 stresskorpus",
        author="Deterministic local fixture generator",
    )
    document.build(
        answer_key_story(corpus),
        onFirstPage=page_furniture,
        onLaterPages=page_furniture,
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    corpus = load_corpus()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = []
    for document in corpus["documents"]:
        output_path = OUTPUT_DIR / f"{document['id']}.pdf"
        page_count = render_document(document, output_path)
        generated.append(
            {
                "id": document["id"],
                "client": document["client"],
                "path": str(output_path.relative_to(REPOSITORY_ROOT)),
                "pages": page_count,
                "bytes": output_path.stat().st_size,
                "sha256": file_sha256(output_path),
            }
        )
    render_answer_key(corpus)
    manifest = {
        "version": corpus["version"],
        "documents": generated,
        "answer_key": {
            "path": str(ANSWER_KEY_PATH.relative_to(REPOSITORY_ROOT)),
            "bytes": ANSWER_KEY_PATH.stat().st_size,
            "sha256": file_sha256(ANSWER_KEY_PATH),
        },
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "event": "document_analysis_stress_corpus_generated",
                "documents": len(generated),
                "answer_key": str(ANSWER_KEY_PATH),
                "manifest": str(MANIFEST_PATH),
            }
        )
    )


if __name__ == "__main__":
    main()

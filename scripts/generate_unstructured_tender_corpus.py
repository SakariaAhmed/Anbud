from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, Spacer, Table, TableStyle

from generate_complex_tender_corpus import (
    CONTENT_WIDTH,
    FONT_BOLD,
    INK,
    LIGHT_GREY,
    LINE,
    STYLES,
    TenderDocument,
    answer_key_markdown,
    callout,
    cover_story,
    paragraph,
    rich_paragraph,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = (
    REPOSITORY_ROOT / "test-data" / "complex-tender-corpus" / "scenarios.json"
)
OUTPUT_DIR = REPOSITORY_ROOT / "output" / "pdf" / "unstructured-tender-corpus"

VARIANTS = [
    "workshop-notes",
    "narrative-memo",
    "numbered-brief",
    "trailing-references",
    "mixed-minutes",
]


def bullet_items(items: list[str]) -> list[Paragraph]:
    return [
        Paragraph(
            f"<bullet>&#8226;</bullet>{escape(item)}",
            STYLES["bullet"],
        )
        for item in items
    ]


def requirement_heading(
    requirement: dict[str, Any],
    index: int,
    variant: str,
) -> str:
    requirement_id = requirement["id"]
    topic = requirement["topic"]
    priority = requirement["priority"]
    if variant == "workshop-notes":
        return f"Arbeidsnotat {index}: {topic} [{requirement_id}] - prioritet {priority}"
    if variant == "narrative-memo":
        return f"Krav {requirement_id}: {topic} (prioritet {priority})"
    if variant == "numbered-brief":
        return f"{index}) {topic} - referanse {requirement_id}, prioritet {priority}"
    if variant == "trailing-references":
        return f"Behovsområde {index}: {topic}"
    return f"Referatpunkt {index} - {topic} ({requirement_id}, prioritet {priority})"


def requirement_body(
    requirement: dict[str, Any],
    variant: str,
) -> str:
    text = requirement["text"]
    if variant == "trailing-references":
        return (
            f"{text} Kravreferanse: {requirement['id']}. "
            f"Klassifisering: prioritet {requirement['priority']}."
        )
    return text


def answer_lead(requirement_id: str, variant: str) -> str:
    if variant == "workshop-notes":
        return f"Leverandørens bindende svar til {requirement_id}"
    if variant == "narrative-memo":
        return f"Svar på krav {requirement_id}"
    if variant == "numbered-brief":
        return f"Respons {requirement_id}"
    if variant == "trailing-references":
        return f"Bindende svar - kravreferanse {requirement_id}"
    return f"Beslutning og svar ({requirement_id})"


def distractor_text(scenario: dict[str, Any]) -> str:
    first = scenario["requirements"][0]["id"]
    last = scenario["requirements"][-1]["id"]
    return (
        f"Dokumentet viser til {scenario['contract']}, ISO 27001, TLS 1.3 og "
        "eventuelle domenestandarder som FHIR R4. Disse betegnelsene er ikke "
        f"krav-ID-er. Krysshenvisninger til {first} og {last} senere i teksten "
        "skal heller ikke opprette nye kravrader."
    )


def unstructured_requirement_story(
    scenario: dict[str, Any],
    *,
    include_answer: bool,
    variant: str,
) -> list[Any]:
    story: list[Any] = [
        paragraph(
            "Kravene nedenfor er bevisst skrevet som fritekst, notater og "
            "enkeltavsnitt. Det finnes ingen kravtabell.",
        ),
        callout("Lesemerknad", distractor_text(scenario), risk=True),
        Spacer(1, 2 * mm),
    ]
    for index, requirement in enumerate(scenario["requirements"], start=1):
        block: list[Any] = [
            rich_paragraph(
                f'<font name="{FONT_BOLD}">{escape(requirement_heading(requirement, index, variant))}</font>',
                "h2",
            ),
            paragraph(requirement_body(requirement, variant)),
        ]
        if include_answer:
            block.extend(
                [
                    rich_paragraph(
                        f'<font name="{FONT_BOLD}">{escape(answer_lead(requirement["id"], variant))}</font>',
                        "body",
                    ),
                    paragraph(requirement["answer"]),
                ]
            )
        story.extend([KeepTogether(block), Spacer(1, 2.5 * mm)])

        if index in {4, 8}:
            story.append(
                callout(
                    "Mellomnotat - ikke et nytt krav",
                    f"Prosjektgruppen skal kontrollere sammenhengen mellom "
                    f"{scenario['requirements'][index - 1]['id']} og "
                    f"{scenario['requirements'][index]['id']}. Notatet endrer "
                    "ikke kravregisteret og skal ikke gi en ekstra rad.",
                )
            )
    story.extend(
        [
            paragraph("Krysshenvisninger og dokumentkontroll", "h1"),
            paragraph(
                f"Ved samlet vurdering må {scenario['requirements'][0]['id']}, "
                f"{scenario['requirements'][5]['id']} og "
                f"{scenario['requirements'][-1]['id']} ses i sammenheng. "
                "Dette avsnittet er forklarende og inneholder ingen nye krav."
            ),
        ]
    )
    return story


def bilag_1_story(
    scenario: dict[str, Any],
    *,
    variant: str,
) -> list[Any]:
    story = cover_story(
        scenario,
        "Bilag 1 - ustrukturert",
        "Kundens behov og krav i fritekst",
        "Konkurransegrunnlag - ustrukturert stresstest",
    )
    story.append(paragraph("1. Virksomhet og behov", "h1"))
    story.extend(paragraph(item) for item in scenario["background"])
    story.append(paragraph("2. Mål og effekter", "h1"))
    story.extend(bullet_items(scenario["goals"]))
    story.append(paragraph("3. Føringer og avgrensninger", "h1"))
    story.extend(bullet_items(scenario["constraints"]))
    story.append(paragraph("4. Tildeling", "h1"))
    story.extend(bullet_items(scenario["evaluation"]))
    story.append(paragraph("5. Ustrukturert kravbeskrivelse", "h1"))
    story.extend(
        unstructured_requirement_story(
            scenario,
            include_answer=False,
            variant=variant,
        )
    )
    story.append(paragraph("6. Åpne forhold", "h1"))
    story.extend(bullet_items(scenario["ambiguities"]))
    return story


def bilag_2_story(
    scenario: dict[str, Any],
    *,
    variant: str,
) -> list[Any]:
    good = scenario["good_solution"]
    story = cover_story(
        scenario,
        "Bilag 2 - ustrukturert",
        "Leverandørens løsning og fritekstsvar",
        f"Tilbudsbesvarelse fra {scenario['supplier']} - ustrukturert stresstest",
    )
    story.append(paragraph("1. Tilbudt løsning", "h1"))
    story.append(
        rich_paragraph(
            f'<font name="{FONT_BOLD}">{escape(scenario["solution_name"])}</font> '
            f'{escape(good["summary"])}'
        )
    )
    story.append(paragraph("2. Målarkitektur", "h1"))
    story.extend(bullet_items(good["architecture"]))
    story.append(paragraph("3. Gjennomføring", "h1"))
    story.extend(bullet_items(good["delivery"]))
    story.append(paragraph("4. Ustrukturert krav-for-krav-besvarelse", "h1"))
    story.extend(
        unstructured_requirement_story(
            scenario,
            include_answer=True,
            variant=variant,
        )
    )
    story.append(paragraph("5. Dokumentert verdi", "h1"))
    story.extend(bullet_items(good["win_themes"]))
    story.append(paragraph("6. Forutsetninger og risiko", "h1"))
    story.extend(bullet_items(good["key_risks"]))
    return story


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


def plain_requirement_lines(
    scenario: dict[str, Any],
    *,
    include_answer: bool,
    variant: str,
) -> list[str]:
    lines = [
        "KRAVENE ER USTRUKTURERTE - DET FINNES INGEN KRAVTABELL",
        distractor_text(scenario),
        "",
    ]
    for index, requirement in enumerate(scenario["requirements"], start=1):
        lines.extend(
            [
                requirement_heading(requirement, index, variant),
                requirement_body(requirement, variant),
            ]
        )
        if include_answer:
            lines.extend(
                [
                    answer_lead(requirement["id"], variant),
                    requirement["answer"],
                ]
            )
        lines.append("")
        if index in {4, 8}:
            lines.extend(
                [
                    "Mellomnotat - ikke et nytt krav",
                    f"Prosjektgruppen skal kontrollere sammenhengen mellom "
                    f"{scenario['requirements'][index - 1]['id']} og "
                    f"{scenario['requirements'][index]['id']}. Notatet endrer "
                    "ikke kravregisteret og skal ikke gi en ekstra rad.",
                    "",
                ]
            )
    lines.extend(
        [
            "KRYSSHENVISNINGER OG DOKUMENTKONTROLL",
            f"Ved samlet vurdering må {scenario['requirements'][0]['id']}, "
            f"{scenario['requirements'][5]['id']} og "
            f"{scenario['requirements'][-1]['id']} ses i sammenheng. "
            "Dette avsnittet er forklarende og inneholder ingen nye krav.",
        ]
    )
    return lines


def plain_text(
    scenario: dict[str, Any],
    *,
    include_answer: bool,
    variant: str,
) -> str:
    lines = [
        "BILAG 2 - USTRUKTURERT LEVERANDØRSVAR"
        if include_answer
        else "BILAG 1 - USTRUKTURERTE KUNDEKRAV",
        scenario["project_name"],
        f"Kunde: {scenario['customer']}",
        f"Anskaffelse: {scenario['procurement']}",
        f"Kontrakt: {scenario['contract']}",
        f"Dokumentmønster: {variant}",
        "",
        "VIRKSOMHET OG BEHOV",
        *scenario["background"],
        "",
        "MÅL OG EFFEKTER",
        *scenario["goals"],
        "",
        "FØRINGER OG AVGRENSNINGER",
        *scenario["constraints"],
        "",
        "TILDELING",
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
    lines.extend(
        plain_requirement_lines(
            scenario,
            include_answer=include_answer,
            variant=variant,
        )
    )
    lines.extend(["", "ÅPNE FORHOLD", *scenario["ambiguities"]])
    if include_answer:
        lines.extend(
            [
                "",
                "DOKUMENTERT VERDI",
                *scenario["good_solution"]["win_themes"],
                "",
                "FORUTSETNINGER OG RISIKO",
                *scenario["good_solution"]["key_risks"],
            ]
        )
    return "\n".join(lines).strip() + "\n"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    source = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
    scenarios = source["scenarios"]
    if len(scenarios) != 5:
        raise ValueError(
            f"Testkorpuset skal ha nøyaktig fem scenarioer, fant {len(scenarios)}."
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_documents: list[dict[str, Any]] = []
    corpus_answer_keys: list[dict[str, Any]] = []

    for scenario, variant in zip(scenarios, VARIANTS, strict=True):
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
            document_label="Bilag 1 - ustrukturert",
            story=bilag_1_story(scenario, variant=variant),
        )
        build_pdf(
            bilag_2_pdf,
            scenario,
            document_label="Bilag 2 - ustrukturert",
            story=bilag_2_story(scenario, variant=variant),
        )
        bilag_1_txt.write_text(
            plain_text(scenario, include_answer=False, variant=variant),
            encoding="utf-8",
        )
        bilag_2_txt.write_text(
            plain_text(scenario, include_answer=True, variant=variant),
            encoding="utf-8",
        )
        answer_payload = {
            "scenario_id": slug,
            "project_name": scenario["project_name"],
            "document_pattern": variant,
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
                    "document_pattern": variant,
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
        "corpus": "unstructured-tender-corpus",
        "fictional": True,
        "scenario_count": len(scenarios),
        "document_count": len(manifest_documents),
        "generated_at": "2026-07-31",
        "source": str(SOURCE_PATH.relative_to(REPOSITORY_ROOT)),
        "design": (
            "Samme semantiske fasit som det strukturerte korpuset, men fem "
            "forskjellige fritekstmønstre uten kravtabeller."
        ),
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

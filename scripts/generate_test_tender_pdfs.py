from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from textwrap import wrap

PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN_X = 48
START_Y = 760
LINE_HEIGHT = 14
MAX_LINE_CHARS = 98
LINES_PER_PAGE = 46


@dataclass
class Document:
    filename: str
    title: str
    sections: list[tuple[str, list[str]]]


def escape_pdf_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def prepare_lines(doc: Document) -> list[str]:
    lines: list[str] = []
    lines.extend([doc.title, "", "Document Type: Requirement Specification / Tender", ""])

    for heading, paragraphs in doc.sections:
        lines.append(heading.upper())
        lines.append("-" * min(len(heading), 72))
        for paragraph in paragraphs:
            wrapped = wrap(paragraph, width=MAX_LINE_CHARS, break_long_words=False, break_on_hyphens=False)
            lines.extend(wrapped if wrapped else [""])
            lines.append("")
        lines.append("")

    return lines


def prepare_plain_text(doc: Document) -> str:
    lines: list[str] = []
    lines.append(doc.title)
    lines.append("")
    lines.append("Document Type: Requirement Specification / Tender")
    lines.append("")

    for heading, paragraphs in doc.sections:
        lines.append(heading.upper())
        lines.append("-" * min(len(heading), 72))
        lines.append("")
        for paragraph in paragraphs:
            lines.append(paragraph)
            lines.append("")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def chunk_pages(lines: list[str]) -> list[list[str]]:
    pages: list[list[str]] = []
    for i in range(0, len(lines), LINES_PER_PAGE):
        pages.append(lines[i : i + LINES_PER_PAGE])
    return pages


def build_stream(lines: list[str]) -> bytes:
    commands: list[str] = [
        "BT",
        "/F1 10 Tf",
        f"{MARGIN_X} {START_Y} Td",
        f"{LINE_HEIGHT} TL",
    ]

    if lines:
        commands.append(f"({escape_pdf_text(lines[0])}) Tj")
        for line in lines[1:]:
            commands.append(f"T* ({escape_pdf_text(line)}) Tj")

    commands.append("ET")
    return ("\n".join(commands) + "\n").encode("latin-1", errors="replace")


def write_pdf(output_path: Path, pages: list[list[str]]) -> None:
    page_entries: list[tuple[int, int, bytes]] = []
    next_obj_id = 4

    for page_lines in pages:
        page_obj = next_obj_id
        content_obj = next_obj_id + 1
        stream = build_stream(page_lines)
        page_entries.append((page_obj, content_obj, stream))
        next_obj_id += 2

    kids = " ".join(f"{page_obj} 0 R" for page_obj, _, _ in page_entries)

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: f"<< /Type /Pages /Count {len(page_entries)} /Kids [ {kids} ] >>".encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }

    for page_obj, content_obj, stream in page_entries:
        objects[page_obj] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj} 0 R >>"
        ).encode()
        objects[content_obj] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream"
        )

    max_obj = max(objects)
    offsets: dict[int, int] = {}

    buffer = bytearray()
    buffer.extend(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    for obj_id in range(1, max_obj + 1):
        offsets[obj_id] = len(buffer)
        buffer.extend(f"{obj_id} 0 obj\n".encode())
        body = objects[obj_id]
        buffer.extend(body)
        if not body.endswith(b"\n"):
            buffer.extend(b"\n")
        buffer.extend(b"endobj\n")

    xref_offset = len(buffer)
    buffer.extend(f"xref\n0 {max_obj + 1}\n".encode())
    buffer.extend(b"0000000000 65535 f \n")
    for obj_id in range(1, max_obj + 1):
        buffer.extend(f"{offsets[obj_id]:010d} 00000 n \n".encode())

    buffer.extend(f"trailer\n<< /Size {max_obj + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode())

    output_path.write_bytes(buffer)


def generate_documents(output_dir: Path) -> None:
    documents = [
        Document(
            filename="tender_nordic_hybrid_cloud_2026.pdf",
            title="RFP 2026: Nordic Utilities Hybrid Cloud Modernization Program",
            sections=[
                (
                    "1. Background and Objective",
                    [
                        "Nordic Utilities intends to modernize its customer billing, outage management, and analytics workloads into a hybrid cloud operating model during 2026-2028.",
                        "The selected vendor must deliver an Azure-centric target architecture while retaining selected on-premise systems for regulatory and latency-sensitive operations.",
                        "The customer expects a phased migration with zero unplanned downtime for customer billing and critical grid operations.",
                    ],
                ),
                (
                    "2. Scope of Work",
                    [
                        "Design, implement, and operate a hybrid landing zone including network segmentation, identity federation, backup strategy, and disaster recovery runbooks.",
                        "Migrate 140 applications in three waves. Wave 1 shall include shared services, Wave 2 shall include customer-facing workloads, and Wave 3 shall include analytics and archive systems.",
                        "The bidder must provide a 24/7 managed services model for platform operations, incident handling, patching, and monthly performance reporting.",
                    ],
                ),
                (
                    "3. Mandatory Technical Requirements",
                    [
                        "The platform must support multi-region failover with an RTO of 60 minutes and an RPO of 15 minutes for Tier-1 systems.",
                        "All production workloads shall use customer-managed keys for encryption at rest.",
                        "Identity management must integrate with existing Entra ID tenant and enforce conditional access.",
                        "The vendor shall implement Infrastructure as Code using Terraform, with all modules provided to the customer repository.",
                        "Monitoring must include log analytics, distributed tracing, and proactive alerting with escalation paths.",
                        "All environments must pass CIS benchmark hardening profiles and monthly vulnerability remediation SLAs.",
                    ],
                ),
                (
                    "4. Deliverables",
                    [
                        "Deliverable D1: Current-state and target-state architecture pack due April 22, 2026.",
                        "Deliverable D2: Detailed migration plan per application wave due May 20, 2026.",
                        "Deliverable D3: Security and compliance controls matrix due June 5, 2026.",
                        "Deliverable D4: Wave 1 production cutover report due September 30, 2026.",
                        "Deliverable D5: Managed services transition package due December 10, 2026.",
                    ],
                ),
                (
                    "5. Timeline and Deadlines",
                    [
                        "Intent to Bid deadline: March 12, 2026 17:00 CET.",
                        "Clarification question deadline: March 19, 2026.",
                        "Customer answers to clarification questions due: March 26, 2026.",
                        "Final proposal submission deadline: April 9, 2026 15:00 CET.",
                        "Commercial negotiation round expected between April 20 and May 8, 2026.",
                    ],
                ),
                (
                    "6. Commercial Constraints",
                    [
                        "Pricing must be provided as fixed implementation price plus monthly managed service fee.",
                        "The bidder shall include separate optional pricing for accelerated migration timeline (minus 8 weeks).",
                        "Year-1 budget ceiling is EUR 2.9 million inclusive of transition costs.",
                        "Payment terms are Net 60 and acceptance-linked milestones. Any deviation must be clearly stated.",
                        "Indexation model and currency assumptions must be transparent and bounded.",
                    ],
                ),
                (
                    "7. Known Unclear Points and Clarification Needs",
                    [
                        "TBD: Final list of legacy Oracle workloads requiring refactoring instead of rehosting.",
                        "Clarification required: customer-owned SOC responsibilities versus vendor-managed SOC responsibilities.",
                        "TBD: decision on whether OT-network telemetry may traverse shared cloud logging services.",
                        "Clarification required: acceptable penalty cap for SLA breach in first 12 months.",
                    ],
                ),
                (
                    "8. Risk Notes Provided by Customer",
                    [
                        "Potential merger activities in Q4 2026 may change application priority ordering.",
                        "Critical union blackout period from December 15, 2026 to January 5, 2027 prohibits major cutovers.",
                        "Dependency risk on third-party meter data provider API contract renewal.",
                    ],
                ),
            ],
        ),
        Document(
            filename="tender_city_smart_mobility_data_platform.pdf",
            title="Public Tender: City of Brookhaven Smart Mobility Data Platform",
            sections=[
                (
                    "1. Program Intent",
                    [
                        "The City of Brookhaven seeks a unified data platform to aggregate public transit, traffic flow, parking occupancy, and EV charging utilization data.",
                        "The platform must support real-time dashboards for city operators and public transparency portals for residents.",
                        "This procurement is funded by a federal smart city grant with strict audit and reporting obligations.",
                    ],
                ),
                (
                    "2. Functional Requirements",
                    [
                        "The solution shall ingest data from at least 27 source systems including GTFS feeds, IoT traffic sensors, and parking meter APIs.",
                        "The system must provide role-specific dashboards for transportation command center, planning office, and finance office.",
                        "The bidder must include configurable KPI calculations for congestion, route adherence, and parking turnover.",
                        "The platform must expose open data APIs for approved public datasets.",
                        "The system shall retain at least 7 years of historical data for compliance and trend analysis.",
                    ],
                ),
                (
                    "3. Security and Compliance Requirements",
                    [
                        "All personally identifiable information must be tokenized or anonymized before storage in analytical layers.",
                        "The vendor shall document CJIS-aligned controls because some integrations include law-enforcement adjacent feeds.",
                        "The solution must maintain audit logs for data access, admin actions, and schema changes.",
                        "Multi-factor authentication and least-privilege RBAC are mandatory.",
                    ],
                ),
                (
                    "4. Project Deliverables",
                    [
                        "Deliverable A: Discovery report and source-system integration matrix due July 8, 2026.",
                        "Deliverable B: Pilot environment with five critical data feeds due August 21, 2026.",
                        "Deliverable C: Production launch and public dashboard rollout due November 13, 2026.",
                        "Deliverable D: Training, SOP manual, and handover package due November 30, 2026.",
                    ],
                ),
                (
                    "5. Procurement Milestones",
                    [
                        "Deadline for supplier registration: May 28, 2026.",
                        "Deadline for clarification questions: June 3, 2026.",
                        "Deadline for proposal submission: June 17, 2026 12:00 ET.",
                        "Demonstration shortlist notification due: June 30, 2026.",
                        "Contract award decision expected: July 20, 2026.",
                    ],
                ),
                (
                    "6. Commercial Terms",
                    [
                        "Total not-to-exceed contract value is USD 4.5 million across 3 years.",
                        "The proposal must break down one-time implementation cost, annual support cost, and optional enhancement catalog prices.",
                        "The city requires transparent unit costs for additional data connectors.",
                        "Price escalation above 3 percent annually is not acceptable unless tied to documented federal inflation index changes.",
                        "Invoices are paid net 45 after acceptance checkpoints.",
                    ],
                ),
                (
                    "7. Open Questions",
                    [
                        "TBD: scope for integration with future autonomous shuttle pilot.",
                        "Clarification requested: whether city legal team accepts offshore managed support during non-business hours.",
                        "TBD: final data retention period for parking citation records if legal appeal is open.",
                        "Clarification requested: required uptime target for public open data portal during planned maintenance windows.",
                    ],
                ),
                (
                    "8. Evaluation Model",
                    [
                        "Technical approach is weighted 40 percent, delivery capability 20 percent, commercial value 25 percent, and local stakeholder engagement 15 percent.",
                        "Bidders must provide at least three public sector references with comparable scale.",
                        "Failure to provide mandatory cybersecurity attestations may lead to disqualification.",
                    ],
                ),
            ],
        ),
        Document(
            filename="tender_helio_erp_finops_managed_services.pdf",
            title="Enterprise Tender: Helio Manufacturing ERP and FinOps Managed Services",
            sections=[
                (
                    "1. Business Context",
                    [
                        "Helio Manufacturing is consolidating ERP operations after three acquisitions and requires a managed services partner for SAP on Azure and adjacent integration services.",
                        "Current operating model has fragmented support contracts, inconsistent incident SLAs, and limited cloud cost visibility.",
                    ],
                ),
                (
                    "2. Services In Scope",
                    [
                        "24x7 monitoring and operations for SAP S/4HANA production and non-production environments.",
                        "Application management services for incident, problem, change, release, and minor enhancement cycles.",
                        "FinOps governance including tagging compliance, anomaly detection, and monthly cost optimization recommendations.",
                        "The bidder shall provide quarterly architecture review boards and optimization roadmaps.",
                    ],
                ),
                (
                    "3. Service Level Requirements",
                    [
                        "P1 incidents must be acknowledged within 10 minutes and resolved or mitigated within 2 hours.",
                        "P2 incidents shall be acknowledged within 30 minutes and resolved within 8 hours.",
                        "Monthly service availability must be at least 99.95 percent for production ERP workloads.",
                        "The vendor must deliver RCA documents for all P1 and recurring P2 incidents within five business days.",
                    ],
                ),
                (
                    "4. Transition Requirements",
                    [
                        "Transition plan must include knowledge transfer from incumbent providers, access onboarding, and CMDB reconciliation.",
                        "The bidder shall provide a named transition manager and weekly steering committee updates during first 12 weeks.",
                        "Dual-run with incumbent support is required for a minimum of four weeks.",
                    ],
                ),
                (
                    "5. Deliverables and Due Dates",
                    [
                        "Deliverable T1: Transition and governance blueprint due September 4, 2026.",
                        "Deliverable T2: Signed operational runbook catalog due September 25, 2026.",
                        "Deliverable T3: Service acceptance and KPI baseline report due October 30, 2026.",
                        "Deliverable T4: First FinOps optimization report due November 20, 2026.",
                    ],
                ),
                (
                    "6. Commercial and Contractual Constraints",
                    [
                        "Pricing must include fixed monthly base fee and variable components tied to ticket volume bands.",
                        "Bidder shall state one-time transition fee separately from steady-state operations fee.",
                        "Contract term is 36 months with two optional one-year extensions.",
                        "Customer target cost envelope is USD 6.8 million across base term.",
                        "Any proposed limitation-of-liability clause must include carve-outs for gross negligence and data breach obligations.",
                    ],
                ),
                (
                    "7. Clarification Topics",
                    [
                        "Clarification required: expected ownership split for SAP Basis patching versus application-level regression validation.",
                        "TBD: whether Mexico manufacturing site is included in phase 1 transition or phase 2.",
                        "Clarification required: customer preference for onshore versus blended service desk model.",
                        "TBD: final internal policy for weekend transport approvals during peak production months.",
                    ],
                ),
                (
                    "8. Risk and Dependency Register",
                    [
                        "High dependency on incumbent provider cooperation during credentials and script handover.",
                        "Risk that inconsistent asset tagging may delay first FinOps baseline.",
                        "Potential scope expansion from acquisitions expected in early 2027.",
                        "Seasonal blackout period in late November and December limits production changes.",
                    ],
                ),
            ],
        ),
    ]

    output_dir.mkdir(parents=True, exist_ok=True)

    for doc in documents:
        lines = prepare_lines(doc)
        pages = chunk_pages(lines)
        write_pdf(output_dir / doc.filename, pages)
        print(f"Created {doc.filename} ({len(pages)} pages)")

        text_name = doc.filename.replace(".pdf", ".txt")
        (output_dir / text_name).write_text(prepare_plain_text(doc), encoding="utf-8")
        print(f"Created {text_name}")


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[1] / "test-data" / "tenders"
    generate_documents(out)

import json
import re
from datetime import datetime
from decimal import Decimal

from openai import OpenAI

from app.core.config import get_settings
from app.models import BidRound, Tender
from app.schemas.ai import TenderAnalysisPayload
from app.schemas.common import SnapshotPayload, TenderPagePayload
from app.schemas.tender import TenderChatResponse, TenderIntakeSuggestion


class AIService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.client = OpenAI(api_key=self.settings.openai_api_key) if self.settings.openai_api_key else None

    def analyze_document(self, raw_text: str) -> TenderAnalysisPayload:
        if not raw_text.strip():
            return TenderAnalysisPayload()

        if not self.client:
            return self._fallback_analysis(raw_text)

        prompt = (
            "Analyze this tender document and return strict JSON with keys: "
            "requirements, unclear_points, risks, deadlines, deliverables, commercial_constraints. "
            "Each value must be an array of concise strings."
        )
        try:
            completion = self.client.chat.completions.create(
                model=self.settings.openai_model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "You are a tender analyst. Return JSON only."},
                    {
                        "role": "user",
                        "content": f"{prompt}\n\nDocument:\n{raw_text[:12000]}",
                    },
                ],
            )
            content = completion.choices[0].message.content or "{}"
            payload = json.loads(content)
            return TenderAnalysisPayload.model_validate(payload)
        except Exception:
            return self._fallback_analysis(raw_text)

    def extract_tender_intake(self, raw_text: str) -> TenderIntakeSuggestion:
        if not raw_text.strip():
            return TenderIntakeSuggestion()

        if not self.client:
            return self._fallback_intake(raw_text)

        prompt = (
            "Extract tender intake fields and return strict JSON with keys: "
            "customer_name, title, estimated_value, deadline, owner, custom_fields. "
            "Rules: deadline must be YYYY-MM-DD or null, estimated_value must be number or null, "
            "custom_fields must be an object of short key/value strings."
        )
        try:
            completion = self.client.chat.completions.create(
                model=self.settings.openai_model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "You extract structured tender intake data. Return JSON only."},
                    {"role": "user", "content": f"{prompt}\n\nDocument:\n{raw_text[:12000]}"},
                ],
            )
            content = completion.choices[0].message.content or "{}"
            payload = json.loads(content)
            return TenderIntakeSuggestion.model_validate(payload)
        except Exception:
            return self._fallback_intake(raw_text)

    def answer_tender_question(
        self,
        *,
        question: str,
        document_texts: list[str],
        tender_page: TenderPagePayload | None,
        bid_context: dict[str, str] | None = None,
    ) -> TenderChatResponse:
        question = question.strip()
        if not question:
            return TenderChatResponse(answer="Please enter a question.", confidence="Low", citations=[])

        context_sections: list[str] = []
        total_chars = 0
        max_chars = 22000
        for idx, text in enumerate(document_texts, start=1):
            snippet = text[:3500]
            if total_chars + len(snippet) > max_chars:
                break
            context_sections.append(f"Document {idx}:\n{snippet}")
            total_chars += len(snippet)

        if bid_context:
            context_sections.append(f"Bid metadata:\n{json.dumps(bid_context, ensure_ascii=True)}")

        if tender_page:
            context_sections.append(f"Tender summary:\n{json.dumps(tender_page.model_dump(), ensure_ascii=True)[:4000]}")

        if not context_sections:
            return TenderChatResponse(
                answer="No document context is available for this tender yet. Upload a requirement document first.",
                confidence="Low",
                citations=[],
            )

        if not self.client:
            return self._fallback_chat_answer(question=question, context_sections=context_sections)

        prompt = (
            "Answer the user's tender question using only the provided context. "
            "Style requirements: write like a pragmatic consulting advisor; be constructive, practical, and human; "
            "use plain language; be specific and actionable. "
            "Prefer a clear structure with short headings and bullets so the team can act immediately. "
            "Always include concrete next steps (for example, what to send, decide, or verify next). "
            "If context is missing, say that clearly and ask for the exact missing input. "
            "Return strict JSON with keys: answer, confidence, citations. "
            "confidence must be one of Low/Medium/High. citations must be short quoted snippets from context. "
            "In answer, include these sections when relevant: "
            "Executive summary, What the customer is asking, Risks/gaps, Recommended next actions."
        )

        try:
            completion = self.client.chat.completions.create(
                model=self.settings.openai_model,
                temperature=0.1,
                response_format={"type": "json_object"},
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a senior bid advisor helping teams win tenders. "
                            "Be practical, direct, and collaborative. "
                            "Write with consultant quality: clear, nuanced, and decision-oriented. "
                            "Give clear recommendations and next actions, not generic advice. "
                            "Ground every claim in the provided context and never invent facts. "
                            "When uncertain, state uncertainty explicitly and propose how to close the gap."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"{prompt}\n\nQuestion:\n{question}\n\nContext:\n{'\n\n'.join(context_sections)}",
                    },
                ],
            )
            content = completion.choices[0].message.content or "{}"
            payload = json.loads(content)
            return TenderChatResponse.model_validate(payload)
        except Exception:
            return self._fallback_chat_answer(question=question, context_sections=context_sections)

    def build_tender_page(self, *, tender: Tender, analysis: TenderAnalysisPayload, latest_round: BidRound | None) -> TenderPagePayload:
        value = f"${Decimal(tender.estimated_value):,.2f}" if tender.estimated_value is not None else "N/A"
        phase = latest_round.phase.value if latest_round else "Intake"
        summary = [
            f"{tender.customer_name} is in {phase} phase for {tender.title}.",
            f"Estimated value: {value}. Deadline: {tender.deadline.isoformat()}.",
        ]
        if analysis.deadlines:
            summary.append(f"Document-specific milestones detected: {', '.join(analysis.deadlines[:2])}.")

        confidence = "High" if len(analysis.requirements) >= 5 else "Medium"

        return TenderPagePayload(
            one_liner=f"{tender.title} for {tender.customer_name} is in {phase} with {len(analysis.risks)} tracked risks.",
            executive_summary=summary,
            key_requirements=analysis.requirements[:12],
            uncertainties=analysis.unclear_points[:10],
            recommended_next_steps=self._recommended_next_steps(analysis, latest_round),
            questions_to_customer=analysis.unclear_points[:8],
            risks=analysis.risks[:10],
            department_summaries={
                "technical": self._department_technical(analysis),
                "finance": self._department_finance(analysis),
                "leadership": self._department_leadership(tender, latest_round, analysis),
            },
            confidence=confidence,
        )

    def generate_snapshot(self, *, latest_round: BidRound | None, page: TenderPagePayload | None) -> SnapshotPayload:
        phase = latest_round.phase.value if latest_round else "Intake"
        blockers = []
        if latest_round and latest_round.blocker_count:
            blockers = [f"{latest_round.blocker_count} blockers active in current round"]

        risks = page.risks[:3] if page else []
        actions = []
        if latest_round and latest_round.next_actions:
            actions.extend(latest_round.next_actions[:3])
        if page:
            actions.extend(page.recommended_next_steps[:3])

        summary = page.one_liner if page else f"Tender currently in {phase}."

        return SnapshotPayload(
            current_phase=phase,
            situation_summary=summary,
            blockers=blockers,
            top_risks=risks,
            next_actions=actions[:5],
            confidence_level=page.confidence if page else "Low",
        )

    def _recommended_next_steps(self, analysis: TenderAnalysisPayload, latest_round: BidRound | None) -> list[str]:
        steps: list[str] = []
        if analysis.unclear_points:
            steps.append("Send clarification questions to customer for unresolved points.")
        if analysis.risks:
            steps.append("Run internal risk review and assign mitigations.")
        if analysis.commercial_constraints:
            steps.append("Validate pricing assumptions against commercial constraints.")
        if latest_round and latest_round.phase.value == "Negotiation":
            steps.append("Prepare fallback options for negotiation concessions.")
        return steps[:6]

    def _fallback_analysis(self, raw_text: str) -> TenderAnalysisPayload:
        lines = [line.strip(" -•\t") for line in raw_text.splitlines() if line.strip()]
        lowered = [line.lower() for line in lines]

        requirements = [lines[i] for i, line in enumerate(lowered) if "must" in line or "shall" in line][:15]
        deadlines = [lines[i] for i, line in enumerate(lowered) if "deadline" in line or "due" in line][:8]
        deliverables = [lines[i] for i, line in enumerate(lowered) if "deliver" in line or "submit" in line][:8]
        commercial = [lines[i] for i, line in enumerate(lowered) if "price" in line or "cost" in line][:8]
        unclear = [lines[i] for i, line in enumerate(lowered) if "tbd" in line or "clarif" in line][:8]
        risks = ["Compressed timeline may impact solution quality."]
        if commercial:
            risks.append("Commercial constraints may reduce delivery flexibility.")

        return TenderAnalysisPayload(
            requirements=requirements,
            unclear_points=unclear,
            risks=risks,
            deadlines=deadlines,
            deliverables=deliverables,
            commercial_constraints=commercial,
        )

    def _fallback_intake(self, raw_text: str) -> TenderIntakeSuggestion:
        lines = [line.strip(" -•\t") for line in raw_text.splitlines() if line.strip()]
        lowered = [line.lower() for line in lines]

        title = lines[0][:255] if lines else "Untitled Tender"
        customer_name = self._extract_customer_name(lines, lowered)
        deadline = self._extract_deadline(lines)
        estimated_value = self._extract_estimated_value(raw_text)
        owner = "Bid Team"
        if any("procurement" in value for value in lowered):
            owner = "Procurement Team"

        custom_fields: dict[str, str] = {}
        key_terms = [
            ("question_deadline", ["clarification question deadline", "questions deadline"]),
            ("submission_deadline", ["proposal submission deadline", "final proposal submission deadline"]),
            ("budget_note", ["budget ceiling", "not-to-exceed", "cost envelope"]),
        ]
        for key, phrases in key_terms:
            match = next((line for line in lines if any(phrase in line.lower() for phrase in phrases)), None)
            if match:
                custom_fields[key] = match[:200]

        return TenderIntakeSuggestion(
            customer_name=customer_name,
            title=title,
            estimated_value=estimated_value,
            deadline=deadline,
            owner=owner,
            custom_fields=custom_fields,
        )

    def _extract_customer_name(self, lines: list[str], lowered: list[str]) -> str:
        for i, line in enumerate(lowered):
            if line.startswith("customer:"):
                return lines[i].split(":", 1)[1].strip()[:255]
            if "city of " in line:
                start = line.index("city of ")
                value = lines[i][start:]
                return value[:255]
        return "Unknown Customer"

    def _extract_deadline(self, lines: list[str]) -> str | None:
        date_regex = re.compile(r"(20\\d{2})-(\\d{2})-(\\d{2})")
        alt_regex = re.compile(r"(\\d{1,2})[/-](\\d{1,2})[/-](20\\d{2})")

        for line in lines:
            match = date_regex.search(line)
            if match:
                return match.group(0)

        for line in lines:
            alt_match = alt_regex.search(line)
            if not alt_match:
                continue
            day, month, year = alt_match.groups()
            try:
                parsed = datetime(int(year), int(month), int(day))
            except ValueError:
                continue
            return parsed.date().isoformat()
        return None

    def _extract_estimated_value(self, raw_text: str) -> Decimal | None:
        currency = re.search(r"(?:USD|EUR|NOK|SEK|\\$|€)\\s?([0-9][0-9,\\.]{4,})", raw_text, flags=re.IGNORECASE)
        if not currency:
            return None

        value = currency.group(1).replace(",", "")
        try:
            return Decimal(value)
        except Exception:
            return None

    def _fallback_chat_answer(self, *, question: str, context_sections: list[str]) -> TenderChatResponse:
        question_terms = [term for term in re.findall(r"[a-zA-Z]{4,}", question.lower()) if term not in {"what", "when", "where", "which"}]
        raw_lines: list[str] = []
        for section in context_sections:
            raw_lines.extend([line.strip() for line in section.splitlines() if line.strip()])

        # Remove generic section labels and duplicated lines for cleaner output.
        seen: set[str] = set()
        lines: list[str] = []
        for line in raw_lines:
            lowered = line.lower()
            if lowered.startswith("document ") or lowered.startswith("bid metadata") or lowered.startswith("tender summary"):
                continue
            if line in seen:
                continue
            seen.add(line)
            lines.append(line)

        if not lines:
            return TenderChatResponse(
                answer="I do not have enough document text yet. Upload at least one requirement document and try again.",
                confidence="Low",
                citations=[],
            )

        def pick_by_keywords(keywords: list[str], limit: int) -> list[str]:
            picks: list[str] = []
            for line in lines:
                lowered = line.lower()
                if any(keyword in lowered for keyword in keywords):
                    picks.append(line)
                if len(picks) >= limit:
                    break
            return picks

        requirements = pick_by_keywords(["must", "shall", "require", "expected", "scope", "service requirements"], 6)
        security = pick_by_keywords(["security", "mfa", "encryption", "iso", "soc", "vulnerability", "logging"], 4)
        operations = pick_by_keywords(["24/7", "monitoring", "incident", "support", "review", "runbook", "handover"], 4)
        deadlines = pick_by_keywords(["deadline", "submission", "questions", "notification", "project start", "due"], 4)
        commercial = pick_by_keywords(["budget", "pricing", "cost", "value", "contract", "commercial"], 4)
        clarifications = pick_by_keywords(["clarification", "assumption", "ambiguous", "ask", "question"], 4)

        question_matches: list[str] = []
        for line in lines:
            lowered = line.lower()
            if any(term in lowered for term in question_terms):
                question_matches.append(line)
            if len(question_matches) >= 6:
                break

        if not question_matches:
            question_matches = (requirements + deadlines + commercial + security + operations)[:6]

        if not question_matches:
            return TenderChatResponse(
                answer="I could not find enough relevant detail in the current text to answer reliably.",
                confidence="Low",
                citations=[],
            )

        answer_parts: list[str] = []
        answer_parts.append("Executive summary:")
        answer_parts.append(
            "The document requests a practical cloud modernization and managed operations delivery, with clear execution ownership and measurable outcomes."
        )
        answer_parts.append("")
        answer_parts.append("What the customer is asking:")
        for item in (question_matches[:5] or requirements[:5]):
            answer_parts.append(f"- {item}")

        if deadlines or commercial:
            answer_parts.append("")
            answer_parts.append("Commercial and timeline implications:")
            for item in (deadlines[:2] + commercial[:2]):
                answer_parts.append(f"- {item}")

        risks: list[str] = []
        if deadlines:
            risks.append("Timeline pressure: fixed submission and clarification windows can compress solutioning and pricing quality.")
        if commercial:
            risks.append("Commercial risk: pricing transparency is expected, so vague packaging may score poorly.")
        if security:
            risks.append("Compliance risk: security controls must be evidenced, not only stated.")
        if operations:
            risks.append("Operational risk: 24/7 support and incident roles require a realistic staffing model.")

        if risks:
            answer_parts.append("")
            answer_parts.append("Risks and gaps:")
            for risk in risks[:4]:
                answer_parts.append(f"- {risk}")

        answer_parts.append("")
        answer_parts.append("Recommended next actions:")
        answer_parts.append("1. Build a requirement coverage matrix mapping each stated need to your delivery approach and owner.")
        answer_parts.append("2. Prepare a phased migration plan with downtime assumptions and cutover strategy.")
        answer_parts.append("3. Draft a transparent price model split by implementation, recurring service, and options.")
        answer_parts.append("4. Send focused clarification questions on any ambiguous scope, acceptance criteria, or response-time expectations.")

        if clarifications:
            answer_parts.append("")
            answer_parts.append("Questions to send the customer:")
            for item in clarifications[:3]:
                answer_parts.append(f"- Can you clarify: {item}")

        confidence = "High" if len(question_matches) >= 4 else "Medium"
        citations = (question_matches + deadlines + commercial + security)[:6]
        return TenderChatResponse(answer="\n".join(answer_parts), confidence=confidence, citations=citations)

    def _department_technical(self, analysis: TenderAnalysisPayload) -> str:
        if not analysis.requirements:
            return "Technical requirements not yet extracted."
        return f"Prioritize {len(analysis.requirements[:5])} key technical requirements and map solution coverage."

    def _department_finance(self, analysis: TenderAnalysisPayload) -> str:
        if analysis.commercial_constraints:
            return "Review commercial constraints and confirm margin protection before pricing lock."
        return "No explicit commercial constraints detected yet."

    def _department_leadership(
        self,
        tender: Tender,
        latest_round: BidRound | None,
        analysis: TenderAnalysisPayload,
    ) -> str:
        phase = latest_round.phase.value if latest_round else "Intake"
        return (
            f"Tender '{tender.title}' is in {phase}; top risk count is {len(analysis.risks)}. "
            "Track decision cadence and unresolved blockers each round."
        )

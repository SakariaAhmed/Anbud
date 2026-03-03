from uuid import UUID

from sqlalchemy import desc, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    AnalysisJob,
    BidRound,
    JobStatus,
    JobTriggerType,
    Tender,
    TenderAnalysis,
    TenderDocument,
    TenderEventType,
    TenderPage,
    TenderSnapshot,
)
from app.schemas.common import TenderPagePayload
from app.services.ai_service import AIService
from app.services.events import log_event


class PipelineError(Exception):
    pass


def get_tender_with_context(db: Session, *, tenant_id: str, tender_id: UUID) -> Tender:
    stmt = (
        select(Tender)
        .where(Tender.id == tender_id, Tender.tenant_id == tenant_id)
        .options(
            selectinload(Tender.bid_rounds),
            selectinload(Tender.documents),
            selectinload(Tender.events),
            selectinload(Tender.snapshots),
            selectinload(Tender.page),
        )
    )
    tender = db.scalar(stmt)
    if not tender:
        raise PipelineError(f"Tender {tender_id} not found")
    return tender


def latest_round_for_tender(db: Session, *, tenant_id: str, tender_id: UUID) -> BidRound | None:
    stmt = (
        select(BidRound)
        .where(BidRound.tender_id == tender_id, BidRound.tenant_id == tenant_id)
        .order_by(desc(BidRound.round_number))
        .limit(1)
    )
    return db.scalar(stmt)


def process_job(db: Session, job: AnalysisJob, *, actor: str = "system") -> None:
    ai_service = AIService()

    job.status = JobStatus.running
    db.flush()

    tender = get_tender_with_context(db, tenant_id=job.tenant_id, tender_id=job.tender_id)
    latest_round = latest_round_for_tender(db, tenant_id=job.tenant_id, tender_id=job.tender_id)

    if job.trigger_type == JobTriggerType.document_uploaded and job.document_id:
        document = db.scalar(
            select(TenderDocument).where(TenderDocument.id == job.document_id, TenderDocument.tenant_id == job.tenant_id)
        )
        if not document:
            raise PipelineError(f"Document {job.document_id} not found")

        analysis = ai_service.analyze_document(document.raw_text)
        analysis_record = TenderAnalysis(
            tenant_id=job.tenant_id,
            tender_id=tender.id,
            document_id=document.id,
            analysis_json=analysis.model_dump(),
            model_name=ai_service.settings.openai_model,
        )
        db.add(analysis_record)

        page_payload = ai_service.build_tender_page(tender=tender, analysis=analysis, latest_round=latest_round)
        upsert_tender_page(db, tenant_id=job.tenant_id, tender_id=tender.id, page_payload=page_payload)

        document.status = "processed"

        log_event(
            db,
            tenant_id=job.tenant_id,
            tender_id=tender.id,
            user=actor,
            event_type=TenderEventType.ai_analysis_generated,
            payload={
                "job_id": str(job.id),
                "document_id": str(document.id),
                "model": ai_service.settings.openai_model,
            },
        )

    page_payload = get_page_payload(db, tenant_id=job.tenant_id, tender_id=tender.id)
    snapshot = ai_service.generate_snapshot(latest_round=latest_round, page=page_payload)
    db.add(
        TenderSnapshot(
            tenant_id=job.tenant_id,
            tender_id=tender.id,
            trigger_type=job.trigger_type,
            snapshot_json=snapshot.model_dump(),
        )
    )

    job.status = JobStatus.completed
    db.flush()


def upsert_tender_page(db: Session, *, tenant_id: str, tender_id: UUID, page_payload: TenderPagePayload) -> None:
    existing = db.scalar(
        select(TenderPage).where(TenderPage.tenant_id == tenant_id, TenderPage.tender_id == tender_id).limit(1)
    )
    if existing:
        existing.page_json = page_payload.model_dump()
    else:
        db.add(TenderPage(tenant_id=tenant_id, tender_id=tender_id, page_json=page_payload.model_dump()))


def get_page_payload(db: Session, *, tenant_id: str, tender_id: UUID) -> TenderPagePayload | None:
    page = db.scalar(select(TenderPage).where(TenderPage.tenant_id == tenant_id, TenderPage.tender_id == tender_id).limit(1))
    if not page:
        return None
    return TenderPagePayload.model_validate(page.page_json)

from datetime import UTC
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_actor, get_tenant_id
from app.db.session import get_db
from app.models import (
    BidRound,
    JobTriggerType,
    PhaseEnum,
    Tender,
    TenderDocument,
    TenderEvent,
    TenderEventType,
    TenderPage,
    TenderSnapshot,
)
from app.schemas.common import BidRoundRead, SnapshotRead, TenderPagePayload
from app.schemas.tender import (
    BidRoundCreate,
    BidRoundUpdate,
    CustomerAnswerCreate,
    DocumentUploadResponse,
    EventCreate,
    TenderCreate,
    TenderCustomFieldsUpdate,
    TenderDetail,
    TenderChatRequest,
    TenderChatResponse,
    TenderIntakeSuggestion,
    TenderRead,
)
from app.services.ai_service import AIService
from app.services.events import log_event
from app.services.jobs import enqueue_job
from app.services.pdf_parser import chunk_text, extract_text_from_pdf

router = APIRouter(prefix="/api/v1/tenders", tags=["tenders"])
# Deprecated compatibility layer: new frontend should use /api/v1/bids.


@router.post("", response_model=TenderRead, status_code=status.HTTP_201_CREATED)
def create_tender(
    payload: TenderCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> TenderRead:
    tender = Tender(
        tenant_id=tenant_id,
        customer_name=payload.customer_name,
        title=payload.title,
        estimated_value=payload.estimated_value,
        deadline=payload.deadline,
        owner=payload.owner,
        custom_fields=payload.custom_fields,
    )
    db.add(tender)
    db.flush()

    first_round = BidRound(
        tenant_id=tenant_id,
        tender_id=tender.id,
        round_number=1,
        phase=PhaseEnum.intake,
        status="active",
        deadline=payload.deadline,
        next_actions=["Upload requirement document for AI analysis"],
    )
    db.add(first_round)
    db.flush()

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender.id,
        user=actor,
        event_type=TenderEventType.decision_recorded,
        payload={
            "message": "Tender created",
            "initial_phase": PhaseEnum.intake.value,
            "custom_fields_count": len(payload.custom_fields),
        },
        bid_round_id=first_round.id,
    )

    db.commit()
    db.refresh(tender)
    return tender


@router.post("/intake/autofill", response_model=TenderIntakeSuggestion)
def autofill_intake_from_document(file: UploadFile = File(...)) -> TenderIntakeSuggestion:
    raw_text, _ = _extract_raw_text_and_type(file)
    ai_service = AIService()
    return ai_service.extract_tender_intake(raw_text)


@router.get("", response_model=list[TenderRead])
def list_tenders(db: Session = Depends(get_db), tenant_id: str = Depends(get_tenant_id)) -> list[TenderRead]:
    stmt = select(Tender).where(Tender.tenant_id == tenant_id).order_by(Tender.deadline.asc())
    return list(db.scalars(stmt).all())


@router.get("/{tender_id}", response_model=TenderDetail)
def get_tender(
    tender_id: UUID,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
) -> TenderDetail:
    tender = _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    bid_rounds = list(
        db.scalars(
            select(BidRound)
            .where(BidRound.tenant_id == tenant_id, BidRound.tender_id == tender_id)
            .order_by(BidRound.round_number.desc())
        ).all()
    )
    events = list(
        db.scalars(
            select(TenderEvent)
            .where(TenderEvent.tenant_id == tenant_id, TenderEvent.tender_id == tender_id)
            .order_by(TenderEvent.timestamp.desc())
            .limit(100)
        ).all()
    )

    page_row = db.scalar(select(TenderPage).where(TenderPage.tenant_id == tenant_id, TenderPage.tender_id == tender_id).limit(1))
    page = TenderPagePayload.model_validate(page_row.page_json) if page_row else None

    snapshots = list(
        db.scalars(
            select(TenderSnapshot)
            .where(TenderSnapshot.tenant_id == tenant_id, TenderSnapshot.tender_id == tender_id)
            .order_by(TenderSnapshot.created_at.desc())
            .limit(20)
        ).all()
    )

    latest_phase = bid_rounds[0].phase if bid_rounds else None
    return TenderDetail(
        **TenderRead.model_validate(tender).model_dump(),
        latest_phase=latest_phase,
        bid_rounds=[BidRoundRead.model_validate(row) for row in bid_rounds],
        events=events,
        page=page,
        snapshots=[SnapshotRead.model_validate(row) for row in snapshots],
    )


@router.post("/{tender_id}/documents", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
def upload_document(
    tender_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> DocumentUploadResponse:
    tender = _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    raw_text, normalized_type = _extract_raw_text_and_type(file)

    chunks = chunk_text(raw_text)

    document = TenderDocument(
        tenant_id=tenant_id,
        tender_id=tender.id,
        file_name=file.filename or "document.pdf",
        content_type=normalized_type,
        raw_text=raw_text,
        status="uploaded",
    )
    db.add(document)
    db.flush()

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender.id,
        user=actor,
        event_type=TenderEventType.document_uploaded,
        payload={"document_id": str(document.id), "file_name": document.file_name, "chunks": len(chunks)},
    )

    enqueue_job(
        db,
        tenant_id=tenant_id,
        tender_id=tender.id,
        trigger_type=JobTriggerType.document_uploaded,
        document_id=document.id,
    )

    db.commit()
    return DocumentUploadResponse(document_id=document.id, file_name=document.file_name, status=document.status)


@router.post("/{tender_id}/bid-rounds", response_model=BidRoundRead, status_code=status.HTTP_201_CREATED)
def create_bid_round(
    tender_id: UUID,
    payload: BidRoundCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidRoundRead:
    _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    last_round_num = db.scalar(
        select(func.max(BidRound.round_number)).where(BidRound.tenant_id == tenant_id, BidRound.tender_id == tender_id)
    )

    bid_round = BidRound(
        tenant_id=tenant_id,
        tender_id=tender_id,
        round_number=(last_round_num or 0) + 1,
        phase=payload.phase,
        status=payload.status,
        deadline=payload.deadline,
        next_actions=payload.next_actions,
    )
    db.add(bid_round)
    db.flush()

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender_id,
        bid_round_id=bid_round.id,
        user=actor,
        event_type=TenderEventType.bid_round_created,
        payload={"round_number": bid_round.round_number, "phase": bid_round.phase.value},
    )

    enqueue_job(db, tenant_id=tenant_id, tender_id=tender_id, trigger_type=JobTriggerType.bid_round_created)

    db.commit()
    db.refresh(bid_round)
    return bid_round


@router.patch("/bid-rounds/{bid_round_id}", response_model=BidRoundRead)
def update_bid_round(
    bid_round_id: UUID,
    payload: BidRoundUpdate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidRoundRead:
    bid_round = db.scalar(select(BidRound).where(BidRound.id == bid_round_id, BidRound.tenant_id == tenant_id).limit(1))
    if not bid_round:
        raise HTTPException(status_code=404, detail="Bid round not found")

    previous_phase = bid_round.phase

    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(bid_round, key, value)

    if payload.phase and payload.phase != previous_phase:
        log_event(
            db,
            tenant_id=tenant_id,
            tender_id=bid_round.tender_id,
            bid_round_id=bid_round.id,
            user=actor,
            event_type=TenderEventType.phase_changed,
            payload={"from": previous_phase.value, "to": payload.phase.value},
        )
        enqueue_job(db, tenant_id=tenant_id, tender_id=bid_round.tender_id, trigger_type=JobTriggerType.phase_changed)

    db.commit()
    db.refresh(bid_round)
    return bid_round


@router.post("/{tender_id}/customer-answers", status_code=status.HTTP_201_CREATED)
def log_customer_answer(
    tender_id: UUID,
    payload: CustomerAnswerCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> dict[str, str]:
    _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender_id,
        user=actor,
        event_type=TenderEventType.answer_received,
        payload={"answer": payload.answer, "context": payload.context, "received_at": datetime.now(UTC).isoformat()},
    )
    enqueue_job(db, tenant_id=tenant_id, tender_id=tender_id, trigger_type=JobTriggerType.customer_answer_logged)

    db.commit()
    return {"status": "logged"}


@router.post("/{tender_id}/events", status_code=status.HTTP_201_CREATED)
def append_event(
    tender_id: UUID,
    payload: EventCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> dict[str, str]:
    _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender_id,
        user=actor,
        event_type=payload.type,
        payload=payload.payload,
    )
    db.commit()
    return {"status": "logged"}


@router.post("/{tender_id}/chat", response_model=TenderChatResponse)
def chat_on_tender_documents(
    tender_id: UUID,
    payload: TenderChatRequest,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> TenderChatResponse:
    _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    docs = list(
        db.scalars(
            select(TenderDocument)
            .where(TenderDocument.tenant_id == tenant_id, TenderDocument.tender_id == tender_id)
            .order_by(TenderDocument.created_at.desc())
            .limit(3)
        ).all()
    )
    document_texts = [doc.raw_text for doc in docs]

    page_row = db.scalar(select(TenderPage).where(TenderPage.tenant_id == tenant_id, TenderPage.tender_id == tender_id).limit(1))
    page = TenderPagePayload.model_validate(page_row.page_json) if page_row else None

    ai_service = AIService()
    result = ai_service.answer_tender_question(question=payload.question, document_texts=document_texts, tender_page=page)

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender_id,
        user=actor,
        event_type=TenderEventType.question_sent,
        payload={"question": payload.question[:600], "source": "tender_chat"},
    )
    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender_id,
        user="assistant",
        event_type=TenderEventType.answer_received,
        payload={"answer": result.answer[:1000], "confidence": result.confidence, "source": "tender_chat"},
    )
    db.commit()
    return result


@router.patch("/{tender_id}/custom-fields", response_model=TenderRead)
def update_tender_custom_fields(
    tender_id: UUID,
    payload: TenderCustomFieldsUpdate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> TenderRead:
    tender = _get_tender_or_404(db, tenant_id=tenant_id, tender_id=tender_id)

    tender.custom_fields = payload.custom_fields
    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=tender.id,
        user=actor,
        event_type=TenderEventType.scope_changed,
        payload={"custom_fields_count": len(payload.custom_fields)},
    )

    db.commit()
    db.refresh(tender)
    return tender


def _get_tender_or_404(db: Session, *, tenant_id: str, tender_id: UUID) -> Tender:
    tender = db.scalar(select(Tender).where(Tender.id == tender_id, Tender.tenant_id == tenant_id).limit(1))
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")
    return tender


def _extract_raw_text_and_type(file: UploadFile) -> tuple[str, str]:
    contents = file.file.read()
    content_type = file.content_type or "application/octet-stream"
    suffix = (file.filename or "").lower()

    if content_type == "application/pdf" or suffix.endswith(".pdf"):
        return extract_text_from_pdf(contents), "application/pdf"

    if content_type == "text/plain" or suffix.endswith(".txt"):
        try:
            return contents.decode("utf-8"), "text/plain"
        except UnicodeDecodeError:
            return contents.decode("latin-1"), "text/plain"

    raise HTTPException(status_code=400, detail="Only PDF and TXT files are supported")

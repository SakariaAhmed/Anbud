from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, status, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_actor, get_tenant_id
from app.db.session import get_db
from app.models import BidNote, TenderDocument, TenderEventType, TenderPage
from app.schemas.bid import (
    BidChatRequest,
    BidChatResponse,
    BidCreate,
    BidDocumentRead,
    BidEventRead,
    BidIntakeSuggestion,
    BidNoteCreate,
    BidNoteRead,
    BidRead,
    BidUpdate,
)
from app.schemas.common import TenderPagePayload
from app.services.ai_service import AIService
from app.services.bid_service import BidService
from app.services.document_service import DocumentService, extract_raw_text_and_type
from app.services.events import log_event

router = APIRouter(prefix="/api/v1/bids", tags=["bids"])


@router.post("", response_model=BidRead, status_code=status.HTTP_201_CREATED)
def create_bid(
    payload: BidCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidRead:
    service = BidService(db, tenant_id=tenant_id)
    bid = service.create_bid(payload, actor=actor)
    return BidRead.model_validate(bid)


@router.post("/intake/autofill", response_model=BidIntakeSuggestion)
def autofill_bid_intake_from_document(file: UploadFile = File(...)) -> BidIntakeSuggestion:
    raw_text, _ = extract_raw_text_and_type(file)
    ai_service = AIService()
    suggestion = ai_service.extract_tender_intake(raw_text)
    return BidIntakeSuggestion.model_validate(suggestion.model_dump())


@router.get("", response_model=list[BidRead])
def list_bids(db: Session = Depends(get_db), tenant_id: str = Depends(get_tenant_id)) -> list[BidRead]:
    service = BidService(db, tenant_id=tenant_id)
    return [BidRead.model_validate(row) for row in service.list_bids()]


@router.get("/{bid_id}", response_model=BidRead)
def get_bid(bid_id: UUID, db: Session = Depends(get_db), tenant_id: str = Depends(get_tenant_id)) -> BidRead:
    service = BidService(db, tenant_id=tenant_id)
    bid = service.get_bid(bid_id)
    return BidRead.model_validate(bid)


@router.patch("/{bid_id}", response_model=BidRead)
def update_bid(
    bid_id: UUID,
    payload: BidUpdate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
) -> BidRead:
    service = BidService(db, tenant_id=tenant_id)
    bid = service.update_bid(bid_id, payload)
    return BidRead.model_validate(bid)


@router.post("/{bid_id}/documents", response_model=BidDocumentRead, status_code=status.HTTP_201_CREATED)
def upload_bid_document(
    bid_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidDocumentRead:
    bid_service = BidService(db, tenant_id=tenant_id)
    bid_service.get_bid(bid_id)

    document_service = DocumentService(db, tenant_id=tenant_id)
    document = document_service.upload(bid_id=bid_id, file=file, actor=actor)
    return BidDocumentRead.model_validate(document)


@router.get("/{bid_id}/documents", response_model=list[BidDocumentRead])
def list_bid_documents(
    bid_id: UUID,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
) -> list[BidDocumentRead]:
    bid_service = BidService(db, tenant_id=tenant_id)
    bid_service.get_bid(bid_id)

    document_service = DocumentService(db, tenant_id=tenant_id)
    documents = document_service.list_documents(bid_id=bid_id)
    return [BidDocumentRead.model_validate(doc) for doc in documents]


@router.post("/{bid_id}/chat", response_model=BidChatResponse)
def bid_chat(
    bid_id: UUID,
    payload: BidChatRequest,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidChatResponse:
    bid_service = BidService(db, tenant_id=tenant_id)
    bid = bid_service.get_bid(bid_id)

    docs = list(
        db.scalars(
            select(TenderDocument)
            .where(TenderDocument.tenant_id == tenant_id, TenderDocument.tender_id == bid_id)
            .order_by(TenderDocument.created_at.desc())
        ).all()
    )
    document_texts = [doc.raw_text for doc in docs]

    page_row = db.scalar(select(TenderPage).where(TenderPage.tenant_id == tenant_id, TenderPage.tender_id == bid_id).limit(1))
    page = TenderPagePayload.model_validate(page_row.page_json) if page_row else None

    ai_service = AIService()
    result = ai_service.answer_tender_question(
        question=payload.question,
        document_texts=document_texts,
        tender_page=page,
        bid_context={
            "customer_name": bid.customer_name,
            "title": bid.title,
            "owner": bid.owner,
            "deadline": bid.deadline.isoformat(),
        },
    )

    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=bid_id,
        user=actor,
        event_type=TenderEventType.question_sent,
        payload={"question": payload.question[:1000], "source": "bid_chat"},
    )
    log_event(
        db,
        tenant_id=tenant_id,
        tender_id=bid_id,
        user="assistant",
        event_type=TenderEventType.answer_received,
        payload={
            "answer": result.answer[:2000],
            "confidence": result.confidence,
            "citations": result.citations,
            "source": "bid_chat",
        },
    )
    bid_service.touch_bid_activity(bid_id)

    db.commit()
    return BidChatResponse.model_validate(result.model_dump())


@router.get("/{bid_id}/events", response_model=list[BidEventRead])
def list_bid_events(
    bid_id: UUID,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
) -> list[BidEventRead]:
    service = BidService(db, tenant_id=tenant_id)
    return service.list_events(bid_id)


@router.post("/{bid_id}/notes", response_model=BidNoteRead, status_code=status.HTTP_201_CREATED)
def create_bid_note(
    bid_id: UUID,
    payload: BidNoteCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
    actor: str = Depends(get_actor),
) -> BidNoteRead:
    bid_service = BidService(db, tenant_id=tenant_id)
    bid_service.get_bid(bid_id)

    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Note content cannot be empty")

    note = BidNote(
        tenant_id=tenant_id,
        tender_id=bid_id,
        content=content,
        user=actor,
    )
    db.add(note)
    bid_service.touch_bid_activity(bid_id)
    db.commit()
    db.refresh(note)
    return BidNoteRead.model_validate(note)


@router.get("/{bid_id}/notes", response_model=list[BidNoteRead])
def list_bid_notes(
    bid_id: UUID,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_tenant_id),
) -> list[BidNoteRead]:
    bid_service = BidService(db, tenant_id=tenant_id)
    bid_service.get_bid(bid_id)

    notes = list(
        db.scalars(
            select(BidNote)
            .where(BidNote.tenant_id == tenant_id, BidNote.tender_id == bid_id)
            .order_by(BidNote.created_at.desc())
        ).all()
    )
    return [BidNoteRead.model_validate(note) for note in notes]

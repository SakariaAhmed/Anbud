from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Tender, TenderEvent, TenderEventType
from app.schemas.bid import BidCreate, BidEventRead, BidUpdate, NormalizedEventType
from app.services.events import log_event


class BidService:
    def __init__(self, db: Session, *, tenant_id: str) -> None:
        self.db = db
        self.tenant_id = tenant_id

    def create_bid(self, payload: BidCreate, *, actor: str) -> Tender:
        customer_name = payload.customer_name.strip()
        if not customer_name:
            raise HTTPException(status_code=422, detail="customer_name is required")

        tender = Tender(
            tenant_id=self.tenant_id,
            customer_name=customer_name,
            title=(payload.title or "Untitled Bid").strip() or "Untitled Bid",
            estimated_value=payload.estimated_value,
            deadline=payload.deadline or self._default_deadline(),
            owner=(payload.owner or "Unassigned").strip() or "Unassigned",
            custom_fields=payload.custom_fields,
        )
        self.db.add(tender)
        self.db.flush()

        log_event(
            self.db,
            tenant_id=self.tenant_id,
            tender_id=tender.id,
            user=actor,
            event_type=TenderEventType.decision_recorded,
            payload={"message": "Bid created", "mapped_type": "bid_created"},
        )

        self.db.commit()
        self.db.refresh(tender)
        return tender

    def list_bids(self) -> list[Tender]:
        stmt = select(Tender).where(Tender.tenant_id == self.tenant_id).order_by(Tender.updated_at.desc())
        return list(self.db.scalars(stmt).all())

    def get_bid(self, bid_id: UUID) -> Tender:
        bid = self.db.scalar(select(Tender).where(Tender.id == bid_id, Tender.tenant_id == self.tenant_id).limit(1))
        if not bid:
            raise HTTPException(status_code=404, detail="Bid not found")
        return bid

    def update_bid(self, bid_id: UUID, payload: BidUpdate) -> Tender:
        bid = self.get_bid(bid_id)
        changes = payload.model_dump(exclude_unset=True)

        if "customer_name" in changes and changes["customer_name"] is not None:
            value = changes["customer_name"].strip()
            if not value:
                raise HTTPException(status_code=422, detail="customer_name cannot be empty")
            bid.customer_name = value

        if "title" in changes and changes["title"] is not None:
            bid.title = changes["title"].strip() or "Untitled Bid"

        if "estimated_value" in changes:
            bid.estimated_value = changes["estimated_value"]

        if "deadline" in changes and changes["deadline"] is not None:
            bid.deadline = changes["deadline"]

        if "owner" in changes and changes["owner"] is not None:
            bid.owner = changes["owner"].strip() or "Unassigned"

        if "custom_fields" in changes and changes["custom_fields"] is not None:
            bid.custom_fields = changes["custom_fields"]

        self.db.commit()
        self.db.refresh(bid)
        return bid

    def touch_bid_activity(self, bid_id: UUID) -> None:
        bid = self.get_bid(bid_id)
        bid.updated_at = datetime.now(UTC)
        self.db.flush()

    def list_events(self, bid_id: UUID) -> list[BidEventRead]:
        self.get_bid(bid_id)
        events = list(
            self.db.scalars(
                select(TenderEvent)
                .where(TenderEvent.tenant_id == self.tenant_id, TenderEvent.tender_id == bid_id)
                .order_by(TenderEvent.timestamp.asc())
            ).all()
        )

        normalized: list[BidEventRead] = []
        for event in events:
            event_type = _normalize_event_type(event)
            if not event_type:
                continue
            normalized.append(
                BidEventRead(
                    id=event.id,
                    timestamp=event.timestamp,
                    user=event.user,
                    type=event_type,
                    payload=event.payload or {},
                )
            )

        return normalized

    @staticmethod
    def _default_deadline() -> date:
        return date.today() + timedelta(days=30)


def _normalize_event_type(event: TenderEvent) -> NormalizedEventType | None:
    if event.type == TenderEventType.document_uploaded:
        return "document_uploaded"
    if event.type == TenderEventType.question_sent:
        return "chat_question"
    if event.type == TenderEventType.answer_received:
        return "chat_answer"
    if event.type == TenderEventType.decision_recorded:
        mapped = str((event.payload or {}).get("mapped_type", "")).strip().lower()
        message = str((event.payload or {}).get("message", "")).strip().lower()
        if mapped == "bid_created" or message in {"bid created", "tender created"}:
            return "bid_created"
    return None

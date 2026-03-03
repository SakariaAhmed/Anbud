from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import TenderEvent, TenderEventType


def log_event(
    db: Session,
    *,
    tenant_id: str,
    tender_id: UUID,
    user: str,
    event_type: TenderEventType,
    payload: dict[str, Any],
    bid_round_id: UUID | None = None,
) -> TenderEvent:
    event = TenderEvent(
        tenant_id=tenant_id,
        tender_id=tender_id,
        bid_round_id=bid_round_id,
        user=user,
        type=event_type,
        payload=payload,
    )
    db.add(event)
    db.flush()
    return event

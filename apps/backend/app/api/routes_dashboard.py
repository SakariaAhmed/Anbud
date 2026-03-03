from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_tenant_id
from app.db.session import get_db
from app.models import BidRound, Tender
from app.schemas.dashboard import DashboardResponse, DashboardRow

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse)
def get_dashboard(db: Session = Depends(get_db), tenant_id: str = Depends(get_tenant_id)) -> DashboardResponse:
    tenders = list(db.scalars(select(Tender).where(Tender.tenant_id == tenant_id).order_by(Tender.deadline.asc())).all())

    rows: list[DashboardRow] = []
    today = date.today()
    for tender in tenders:
        rounds = list(
            db.scalars(
                select(BidRound)
                .where(BidRound.tenant_id == tenant_id, BidRound.tender_id == tender.id)
                .order_by(BidRound.round_number.desc())
            ).all()
        )
        latest_round = rounds[0] if rounds else None
        blockers = latest_round.blocker_count if latest_round else 0
        risk_score = Decimal(latest_round.risk_score) if latest_round else Decimal("0")
        next_action = "No next action set"
        if latest_round and latest_round.next_actions:
            next_action = latest_round.next_actions[0]

        rows.append(
            DashboardRow(
                tender_id=tender.id,
                customer=tender.customer_name,
                title=tender.title,
                phase=latest_round.phase if latest_round else None,
                deadline=tender.deadline,
                blockers=blockers,
                next_action=next_action,
                risk_score=risk_score,
                overdue=tender.deadline < today,
                negotiation_highlight=latest_round.phase.value == "Negotiation" if latest_round else False,
            )
        )

    return DashboardResponse(items=rows)

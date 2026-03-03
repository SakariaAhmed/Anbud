from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel

from app.models import PhaseEnum


class DashboardRow(BaseModel):
    tender_id: UUID
    customer: str
    title: str
    phase: PhaseEnum | None
    deadline: date
    blockers: int
    next_action: str
    risk_score: Decimal
    overdue: bool
    negotiation_highlight: bool


class DashboardResponse(BaseModel):
    items: list[DashboardRow]

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models import JobTriggerType, PhaseEnum, TenderEventType


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class EventRead(ORMModel):
    id: UUID
    timestamp: datetime
    user: str
    type: TenderEventType
    payload: dict[str, Any] = Field(default_factory=dict)


class BidRoundRead(ORMModel):
    id: UUID
    round_number: int
    phase: PhaseEnum
    status: str
    deadline: date | None
    open_questions_count: int
    blocker_count: int
    risk_score: Decimal
    next_actions: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class SnapshotRead(ORMModel):
    id: UUID
    trigger_type: JobTriggerType
    snapshot_json: dict[str, Any]
    created_at: datetime


class DepartmentSummary(BaseModel):
    technical: str = ""
    finance: str = ""
    leadership: str = ""


class TenderPagePayload(BaseModel):
    one_liner: str = ""
    executive_summary: list[str] = Field(default_factory=list)
    key_requirements: list[str] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)
    recommended_next_steps: list[str] = Field(default_factory=list)
    questions_to_customer: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    department_summaries: DepartmentSummary = Field(default_factory=DepartmentSummary)
    confidence: str = ""


class SnapshotPayload(BaseModel):
    current_phase: str = ""
    situation_summary: str = ""
    blockers: list[str] = Field(default_factory=list)
    top_risks: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    confidence_level: str = ""

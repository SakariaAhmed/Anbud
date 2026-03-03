from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models import PhaseEnum
from app.models import TenderEventType
from app.schemas.common import BidRoundRead, EventRead, SnapshotRead, TenderPagePayload


class TenderCreate(BaseModel):
    customer_name: str
    title: str
    estimated_value: Decimal | None = None
    deadline: date
    owner: str
    custom_fields: dict[str, str] = Field(default_factory=dict)


class TenderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    customer_name: str
    title: str
    estimated_value: Decimal | None
    deadline: date
    owner: str
    custom_fields: dict[str, str] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class TenderDetail(TenderRead):
    latest_phase: PhaseEnum | None = None
    bid_rounds: list[BidRoundRead] = Field(default_factory=list)
    events: list[EventRead] = Field(default_factory=list)
    page: TenderPagePayload | None = None
    snapshots: list[SnapshotRead] = Field(default_factory=list)


class BidRoundCreate(BaseModel):
    phase: PhaseEnum = PhaseEnum.intake
    status: str = "active"
    deadline: date | None = None
    next_actions: list[str] = Field(default_factory=list)


class BidRoundUpdate(BaseModel):
    phase: PhaseEnum | None = None
    status: str | None = None
    deadline: date | None = None
    open_questions_count: int | None = None
    blocker_count: int | None = None
    risk_score: float | None = None
    next_actions: list[str] | None = None


class DocumentUploadResponse(BaseModel):
    document_id: UUID
    file_name: str
    status: str


class TenderIntakeSuggestion(BaseModel):
    customer_name: str = ""
    title: str = ""
    estimated_value: Decimal | None = None
    deadline: date | None = None
    owner: str = ""
    custom_fields: dict[str, str] = Field(default_factory=dict)


class TenderCustomFieldsUpdate(BaseModel):
    custom_fields: dict[str, str] = Field(default_factory=dict)


class TenderChatRequest(BaseModel):
    question: str


class TenderChatResponse(BaseModel):
    answer: str
    confidence: str = "Medium"
    citations: list[str] = Field(default_factory=list)


class CustomerAnswerCreate(BaseModel):
    answer: str
    context: str = ""


class EventCreate(BaseModel):
    type: TenderEventType
    payload: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

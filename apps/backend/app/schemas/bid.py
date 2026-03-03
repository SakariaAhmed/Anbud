from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


NormalizedEventType = Literal["bid_created", "document_uploaded", "chat_question", "chat_answer"]
ConfidenceLevel = Literal["Low", "Medium", "High"]


class BidCreate(BaseModel):
    customer_name: str
    title: str | None = None
    estimated_value: Decimal | None = None
    deadline: date | None = None
    owner: str | None = None
    custom_fields: dict[str, str] = Field(default_factory=dict)


class BidUpdate(BaseModel):
    customer_name: str | None = None
    title: str | None = None
    estimated_value: Decimal | None = None
    deadline: date | None = None
    owner: str | None = None
    custom_fields: dict[str, str] | None = None


class BidRead(BaseModel):
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


class BidDocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    file_name: str
    content_type: str
    status: str
    created_at: datetime


class BidChatRequest(BaseModel):
    question: str


class BidChatResponse(BaseModel):
    answer: str
    confidence: ConfidenceLevel
    citations: list[str] = Field(default_factory=list)


class BidEventRead(BaseModel):
    id: UUID
    timestamp: datetime
    user: str
    type: NormalizedEventType
    payload: dict[str, Any] = Field(default_factory=dict)


class BidIntakeSuggestion(BaseModel):
    customer_name: str = ""
    title: str = ""
    estimated_value: Decimal | None = None
    deadline: date | None = None
    owner: str = ""
    custom_fields: dict[str, str] = Field(default_factory=dict)


class BidNoteCreate(BaseModel):
    content: str


class BidNoteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    content: str
    user: str
    created_at: datetime

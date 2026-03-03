from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class PhaseEnum(str, enum.Enum):
    intake = "Intake"
    discovery = "Discovery"
    qa = "Q&A"
    solutioning = "Solutioning"
    pricing = "Pricing"
    internal_review = "Internal Review"
    submit = "Submit"
    negotiation = "Negotiation"
    awarded = "Awarded"
    lost = "Lost"


class TenderEventType(str, enum.Enum):
    document_uploaded = "document_uploaded"
    ai_analysis_generated = "ai_analysis_generated"
    question_sent = "question_sent"
    answer_received = "answer_received"
    deadline_updated = "deadline_updated"
    scope_changed = "scope_changed"
    pricing_updated = "pricing_updated"
    decision_recorded = "decision_recorded"
    bid_round_created = "bid_round_created"
    phase_changed = "phase_changed"


class JobTriggerType(str, enum.Enum):
    document_uploaded = "document_uploaded"
    bid_round_created = "bid_round_created"
    customer_answer_logged = "customer_answer_logged"
    phase_changed = "phase_changed"


class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class Tender(Base):
    __tablename__ = "tenders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    customer_name: Mapped[str] = mapped_column(String(255), index=True)
    title: Mapped[str] = mapped_column(String(255), index=True)
    estimated_value: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    deadline: Mapped[date] = mapped_column(Date, index=True)
    owner: Mapped[str] = mapped_column(String(255), index=True)
    custom_fields: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    bid_rounds: Mapped[list["BidRound"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    documents: Mapped[list["TenderDocument"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    events: Mapped[list["TenderEvent"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    analyses: Mapped[list["TenderAnalysis"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    snapshots: Mapped[list["TenderSnapshot"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    notes: Mapped[list["BidNote"]] = relationship(back_populates="tender", cascade="all, delete-orphan")
    page: Mapped[TenderPage | None] = relationship(back_populates="tender", uselist=False, cascade="all, delete-orphan")


class BidRound(Base):
    __tablename__ = "bid_rounds"
    __table_args__ = (UniqueConstraint("tenant_id", "tender_id", "round_number", name="uq_bid_round_number"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int] = mapped_column(Integer)
    phase: Mapped[PhaseEnum] = mapped_column(Enum(PhaseEnum, name="phase_enum"), index=True)
    status: Mapped[str] = mapped_column(String(64), default="active")
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    open_questions_count: Mapped[int] = mapped_column(Integer, default=0)
    blocker_count: Mapped[int] = mapped_column(Integer, default=0)
    risk_score: Mapped[float] = mapped_column(Numeric(4, 2), default=0)
    next_actions: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    tender: Mapped[Tender] = relationship(back_populates="bid_rounds")
    events: Mapped[list["TenderEvent"]] = relationship(back_populates="bid_round")


class TenderDocument(Base):
    __tablename__ = "tender_documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(255), default="application/pdf")
    raw_text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="uploaded")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    tender: Mapped[Tender] = relationship(back_populates="documents")


class TenderEvent(Base):
    __tablename__ = "tender_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    bid_round_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bid_rounds.id", ondelete="SET NULL"), nullable=True
    )
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    user: Mapped[str] = mapped_column(String(255), default="system")
    type: Mapped[TenderEventType] = mapped_column(Enum(TenderEventType, name="event_type_enum"), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)

    tender: Mapped[Tender] = relationship(back_populates="events")
    bid_round: Mapped[BidRound | None] = relationship(back_populates="events")


class TenderAnalysis(Base):
    __tablename__ = "tender_analyses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tender_documents.id", ondelete="SET NULL"), nullable=True
    )
    analysis_json: Mapped[dict] = mapped_column(JSON)
    model_name: Mapped[str] = mapped_column(String(128))
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    tender: Mapped[Tender] = relationship(back_populates="analyses")


class TenderPage(Base):
    __tablename__ = "tender_pages"
    __table_args__ = (UniqueConstraint("tenant_id", "tender_id", name="uq_tender_page_tender"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    page_json: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    tender: Mapped[Tender] = relationship(back_populates="page")


class TenderSnapshot(Base):
    __tablename__ = "tender_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    trigger_type: Mapped[JobTriggerType] = mapped_column(Enum(JobTriggerType, name="snapshot_trigger_enum"))
    snapshot_json: Mapped[dict] = mapped_column(JSON)
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    tender: Mapped[Tender] = relationship(back_populates="snapshots")


class BidNote(Base):
    __tablename__ = "bid_notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    content: Mapped[str] = mapped_column(Text)
    user: Mapped[str] = mapped_column(String(255), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    tender: Mapped[Tender] = relationship(back_populates="notes")


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tender_documents.id", ondelete="SET NULL"), nullable=True
    )
    trigger_type: Mapped[JobTriggerType] = mapped_column(Enum(JobTriggerType, name="job_trigger_enum"), index=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus, name="job_status_enum"), default=JobStatus.pending, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

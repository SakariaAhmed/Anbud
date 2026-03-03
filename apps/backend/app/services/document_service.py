from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Tender, TenderDocument, TenderEventType
from app.services.events import log_event
from app.services.pdf_parser import extract_text_from_pdf


class DocumentService:
    def __init__(self, db: Session, *, tenant_id: str) -> None:
        self.db = db
        self.tenant_id = tenant_id

    def upload(self, *, bid_id: UUID, file: UploadFile, actor: str) -> TenderDocument:
        raw_text, normalized_type = extract_raw_text_and_type(file)

        document = TenderDocument(
            tenant_id=self.tenant_id,
            tender_id=bid_id,
            file_name=file.filename or "document.txt",
            content_type=normalized_type,
            raw_text=raw_text,
            status="uploaded",
        )
        self.db.add(document)
        self.db.flush()

        log_event(
            self.db,
            tenant_id=self.tenant_id,
            tender_id=bid_id,
            user=actor,
            event_type=TenderEventType.document_uploaded,
            payload={
                "document_id": str(document.id),
                "file_name": document.file_name,
                "content_type": document.content_type,
            },
        )

        tender = self.db.scalar(select(Tender).where(Tender.id == bid_id, Tender.tenant_id == self.tenant_id).limit(1))
        if tender:
            tender.updated_at = datetime.now(UTC)

        self.db.commit()
        self.db.refresh(document)
        return document

    def list_documents(self, *, bid_id: UUID) -> list[TenderDocument]:
        stmt = (
            select(TenderDocument)
            .where(TenderDocument.tenant_id == self.tenant_id, TenderDocument.tender_id == bid_id)
            .order_by(TenderDocument.created_at.desc())
        )
        return list(self.db.scalars(stmt).all())


def extract_raw_text_and_type(file: UploadFile) -> tuple[str, str]:
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

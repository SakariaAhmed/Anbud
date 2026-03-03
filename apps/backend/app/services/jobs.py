from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisJob, JobStatus, JobTriggerType


def enqueue_job(
    db: Session,
    *,
    tenant_id: str,
    tender_id: UUID,
    trigger_type: JobTriggerType,
    document_id: UUID | None = None,
) -> AnalysisJob:
    job = AnalysisJob(
        tenant_id=tenant_id,
        tender_id=tender_id,
        trigger_type=trigger_type,
        document_id=document_id,
        status=JobStatus.pending,
    )
    db.add(job)
    db.flush()
    return job


def fetch_next_pending_job(db: Session) -> AnalysisJob | None:
    stmt = select(AnalysisJob).where(AnalysisJob.status == JobStatus.pending).order_by(AnalysisJob.created_at.asc()).limit(1)
    return db.scalar(stmt)

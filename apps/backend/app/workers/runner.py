import time

from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import AnalysisJob, JobStatus
from app.services.jobs import fetch_next_pending_job
from app.services.pipeline import PipelineError, process_job


def run_worker() -> None:
    settings = get_settings()
    print("ANBUD worker started")

    while True:
        with SessionLocal() as db:
            job = fetch_next_pending_job(db)
            if not job:
                db.commit()
                time.sleep(settings.worker_poll_interval_seconds)
                continue

            try:
                process_job(db, job)
                db.commit()
            except (PipelineError, SQLAlchemyError) as exc:
                db.rollback()
                with SessionLocal() as rollback_db:
                    failed_job = rollback_db.get(AnalysisJob, job.id)
                    if failed_job:
                        failed_job.status = JobStatus.failed
                        failed_job.error_message = str(exc)
                        rollback_db.commit()


if __name__ == "__main__":
    run_worker()

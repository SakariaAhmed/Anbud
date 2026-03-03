from sqlalchemy import inspect, text

from app.db.base import Base
from app.db.session import engine


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_tender_custom_fields_column()


def _ensure_tender_custom_fields_column() -> None:
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("tenders")}
    if "custom_fields" in columns:
        return

    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE tenders ADD COLUMN custom_fields JSON NOT NULL DEFAULT '{}'::json"))

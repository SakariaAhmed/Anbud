from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes_bids import router as bids_router
from app.api.routes_dashboard import router as dashboard_router
from app.api.routes_tenders import router as tenders_router
from app.core.config import get_settings
from app.db.init_db import init_db

settings = get_settings()
app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(bids_router)
app.include_router(tenders_router)
app.include_router(dashboard_router)

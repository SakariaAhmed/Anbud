from pydantic import BaseModel, Field


class TenderAnalysisPayload(BaseModel):
    requirements: list[str] = Field(default_factory=list)
    unclear_points: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    deadlines: list[str] = Field(default_factory=list)
    deliverables: list[str] = Field(default_factory=list)
    commercial_constraints: list[str] = Field(default_factory=list)

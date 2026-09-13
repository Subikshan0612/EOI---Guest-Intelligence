"""Health check for the KOI AI service — no dependencies, no external calls."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/v1/health")
def get_health() -> dict:
    return {"status": "healthy"}

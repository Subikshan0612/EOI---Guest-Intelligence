"""
Deterministic health-endpoint test.

Requires no Gemini key, no MongoDB, no network, and no external services —
the FastAPI TestClient drives the app in-process.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_200_and_healthy_status():
    response = client.get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}

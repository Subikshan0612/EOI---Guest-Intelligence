"""
Phase 51 - the optional service-to-service credential (AI_SERVICE_TOKEN).

With no token configured the service behaves exactly as before (isolation is a network rule). With a token configured every endpoint except /v1/health refuses a caller that
does not present it, the refusal reveals nothing about the configured value, and a correct token reaches the endpoint unchanged. No provider is called.
"""

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)
TOKEN = "unit-test-service-token-not-a-secret"


def with_token(monkeypatch, value=TOKEN):
    monkeypatch.setattr(settings, "ai_service_token", value)


def test_no_token_configured_leaves_everything_as_before(monkeypatch):
    with_token(monkeypatch, "")
    assert client.get("/v1/health").status_code == 200
    assert client.post("/v1/vector-similarity", json={}).status_code != 401


def test_token_configured_refuses_a_missing_or_wrong_credential(monkeypatch):
    with_token(monkeypatch)
    for headers in ({}, {"x-koi-service-token": "wrong"}, {"x-koi-service-token": TOKEN + "x"}, {"authorization": f"Bearer {TOKEN}"}):
        response = client.post("/v1/intelligence/analyze", json={}, headers=headers)
        assert response.status_code == 401
        body = response.json()
        assert body["error"]["code"] == "UNAUTHORIZED"
        assert TOKEN not in response.text and "wrong" not in response.text


def test_token_configured_lets_the_right_credential_through_and_keeps_health_open(monkeypatch):
    with_token(monkeypatch)
    assert client.get("/v1/health").status_code == 200
    response = client.post("/v1/intelligence/analyze", json={}, headers={"x-koi-service-token": TOKEN})
    assert response.status_code == 422  # reached the endpoint: the body is simply not a valid analysis request


def test_every_non_health_route_is_covered(monkeypatch):
    with_token(monkeypatch)
    paths = [r.path for r in app.routes if getattr(r, "methods", None) and r.path.startswith("/v1/")]
    assert paths
    for path in paths:
        if path == "/v1/health":
            continue
        method = "post" if "POST" in next(r.methods for r in app.routes if getattr(r, "path", None) == path) else "get"
        assert getattr(client, method)(path).status_code == 401, path

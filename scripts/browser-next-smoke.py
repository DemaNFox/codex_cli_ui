#!/usr/bin/env python3
"""Isolated browser smoke for the opt-in, read-only v2 workspace."""

from __future__ import annotations

import json
import os
from playwright.sync_api import Route, sync_playwright


BASE_URL = os.environ.get("CODEX_WEB_SMOKE_URL", "http://127.0.0.1:4173")
PROJECT_ID = "11111111-1111-4111-8111-111111111111"
THREAD_ID = "thread-v2"
STAMP = "2026-10-12T12:00:00.000Z"


def event(identifier: int, turn: str, kind: str, payload: dict) -> dict:
    return {
        "id": identifier,
        "threadId": THREAD_ID,
        "turnId": turn,
        "kind": kind,
        "phase": "completed",
        "payload": payload,
        "createdAt": STAMP,
    }


def main() -> int:
    project = {
        "id": PROJECT_ID,
        "name": "Project A",
        "path": "/srv/projects/a",
        "archived": False,
        "defaultModel": None,
        "defaultReasoningEffort": None,
        "defaultPermissionPreset": "workspace-write",
        "createdAt": STAMP,
        "updatedAt": STAMP,
    }
    thread = {
        "id": THREAD_ID,
        "projectId": PROJECT_ID,
        "name": "History task",
        "preview": "Prompt",
        "model": None,
        "status": "idle",
        "activeTurnId": None,
        "archived": False,
        "instructionSources": [],
        "createdAt": STAMP,
        "updatedAt": STAMP,
    }
    writes: list[str] = []
    console_errors: list[str] = []

    def route_api(route: Route) -> None:
        request = route.request
        path = request.url.split("/api", 1)[1].split("?", 1)[0]
        if request.method != "GET":
            writes.append(f"{request.method} {path}")
            route.fulfill(status=405, body="")
            return
        if path == "/auth/session":
            body = {"authenticated": True, "username": "nick", "csrfToken": "test", "expiresAt": "2027-01-01T00:00:00.000Z"}
        elif path == "/projects":
            body = [project]
        elif path == "/threads":
            body = [thread]
        elif path == f"/threads/{THREAD_ID}":
            body = {
                "data": thread,
                "events": [
                    event(5, "turn-2", "user-message", {"text": "Recent prompt"}),
                    event(6, "turn-2", "agent-message", {"text": "Recent answer", "messagePhase": "final_answer"}),
                    event(7, "turn-2", "turn", {"status": "completed"}),
                ],
                "conversationEvents": [],
                "eventCursor": 7,
                "oldestEventId": 5,
                "historyTruncated": True,
            }
        elif path == f"/threads/{THREAD_ID}/history":
            body = {
                "events": [
                    event(1, "turn-1", "user-message", {"text": "Old prompt"}),
                    event(2, "turn-1", "agent-message", {"text": "Old answer", "messagePhase": "final_answer"}),
                    event(3, "turn-1", "turn", {"status": "completed"}),
                ],
                "oldestEventId": 1,
                "hasMore": False,
            }
        elif path == f"/threads/{THREAD_ID}/events":
            route.fulfill(status=204, body="")
            return
        else:
            raise AssertionError(f"Unexpected API path: {path}")
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width, height in [(1440, 900), (390, 780)]:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.route("**/api/**", route_api)
            page.goto(f"{BASE_URL}/?ui=next", wait_until="domcontentloaded")
            page.get_by_role("button", name="History task").click()
            page.get_by_text("Recent answer").wait_for()
            page.get_by_role("button", name="Показать предыдущие сообщения").click()
            page.get_by_text("Old answer").wait_for()
            assert page.get_by_text("Recent answer").count() == 1
            assert page.get_by_text("Old prompt").count() == 1
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            assert page.get_by_text("Режим просмотра:").count() == 1
            page.close()
        browser.close()
    assert not writes, writes
    assert not console_errors, console_errors
    print("v2 browser smoke passed: 1440x900 and 390x780, history paging, no writes, no page overflow")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

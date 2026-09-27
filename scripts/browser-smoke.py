#!/usr/bin/env python3
"""Isolated Playwright smoke for the login and per-project archive workflow."""

from __future__ import annotations

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


BASE_URL = os.environ.get("CODEX_WEB_SMOKE_URL", "http://127.0.0.1:4173")


def payload(route: Route, status: int, body: object) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        body=json.dumps(body, ensure_ascii=False),
    )


def main() -> int:
    signed_in = False
    archived = False
    console_errors: list[str] = []
    resolved_user_input: dict[str, object] | None = None
    resolved_permission: dict[str, object] | None = None

    def api(route: Route) -> None:
        nonlocal signed_in, archived, resolved_user_input, resolved_permission
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/auth/session":
            if not signed_in:
                payload(route, 401, {"error": {"message": "Требуется вход"}})
            else:
                payload(route, 200, {"username": "owner", "csrfToken": "csrf-smoke"})
        elif path == "/api/auth/login":
            signed_in = True
            payload(route, 200, {"username": "owner", "csrfToken": "csrf-smoke"})
        elif path == "/api/projects":
            payload(
                route,
                200,
                {
                    "data": [
                        {
                            "id": "p1",
                            "name": "Demo",
                            "path": "/srv/projects/demo",
                            "defaultModel": "gpt-6-astra",
                            "defaultReasoningEffort": "high",
                            "defaultPermissionPreset": "workspace-write",
                            "createdAt": "2026-09-27T12:00:00.000Z",
                        }
                    ]
                },
            )
        elif path == "/api/models":
            payload(
                route,
                200,
                {
                    "data": [
                        {
                            "id": "gpt-6-astra",
                            "displayName": "GPT-6 Astra",
                            "description": "",
                            "isDefault": True,
                            "defaultReasoningEffort": "high",
                            "supportedReasoningEfforts": [
                                {"reasoningEffort": "high", "description": ""}
                            ],
                        }
                    ]
                },
            )
        elif path == "/api/system/capabilities":
            payload(
                route,
                200,
                {
                    "codexVersion": "codex-cli 0.153.4",
                    "appServerReady": True,
                    "authenticated": True,
                    "skills": [],
                    "warnings": [],
                },
            )
        elif path == "/api/threads" and request.method == "GET":
            wants_archived = query.get("archived", ["false"])[0] == "true"
            visible = wants_archived == archived
            payload(
                route,
                200,
                {
                    "data": [
                        {
                            "id": "t1",
                            "projectId": "p1",
                            "name": "Переносимый чат",
                            "preview": "Проверка архива",
                            "archived": archived,
                            "status": "idle",
                            "model": "gpt-6-astra",
                            "reasoningEffort": "high",
                            "permissionPreset": "workspace-write",
                            "approvalPolicy": "on-request",
                            "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                            "createdAt": "2026-09-27T12:00:00.000Z",
                            "updatedAt": "2026-09-27T12:00:00.000Z",
                        }
                    ]
                    if visible
                    else []
                },
            )
        elif path == "/api/threads/t1" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": {
                        "id": "t1",
                        "projectId": "p1",
                        "name": "Переносимый чат",
                        "preview": "Проверка архива",
                        "archived": archived,
                        "status": "idle",
                        "model": "gpt-6-astra",
                        "reasoningEffort": "high",
                        "permissionPreset": "workspace-write",
                        "approvalPolicy": "on-request",
                        "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                        "createdAt": "2026-09-27T12:00:00.000Z",
                        "updatedAt": "2026-09-27T12:00:00.000Z",
                    },
                    "events": [],
                },
            )
        elif path == "/api/threads/t1/archive":
            archived = True
            payload(route, 200, {"data": {"id": "t1", "archived": True}})
        elif path == "/api/threads/t1/unarchive":
            archived = False
            payload(route, 200, {"data": {"id": "t1", "archived": False}})
        elif path == "/api/threads/t1/events":
            events = [
                {
                    "id": 1,
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "kind": "user-input",
                    "phase": "state",
                    "payload": {
                        "request": {
                            "id": "input-1",
                            "method": "item/tool/requestUserInput",
                            "itemId": "item-1",
                            "isBlocking": True,
                            "questions": [
                                {
                                    "id": "secret",
                                    "header": "Секрет",
                                    "question": "Введите тестовое значение",
                                    "options": None,
                                    "isOther": False,
                                    "isSecret": True,
                                }
                            ],
                            "status": "pending",
                        }
                    },
                    "createdAt": "2026-09-27T12:00:01.000Z",
                },
                {
                    "id": 2,
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "kind": "permission-approval",
                    "phase": "state",
                    "payload": {
                        "request": {
                            "id": "permission-1",
                            "method": "item/permissions/requestApproval",
                            "itemId": "item-2",
                            "cwd": "/srv/projects/demo",
                            "reason": "Нужен сетевой доступ",
                            "permissions": {"network": {"enabled": True}},
                            "status": "pending",
                        }
                    },
                    "createdAt": "2026-09-27T12:00:02.000Z",
                },
            ]
            body = "retry: 60000\n" + "".join(
                f"id: {event['id']}\nevent: {event['kind']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                for event in events
            )
            route.fulfill(status=200, content_type="text/event-stream", body=body)
        elif path == "/api/user-input-requests/input-1/resolve":
            resolved_user_input = request.post_data_json
            payload(route, 200, {"data": {"id": "input-1", "status": "accepted"}})
        elif path == "/api/permission-requests/permission-1/resolve":
            resolved_permission = request.post_data_json
            payload(route, 200, {"data": {"id": "permission-1", "status": "accepted"}})
        else:
            payload(route, 404, {"error": {"message": f"Unhandled smoke route: {path}"}})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.route("**/api/**", api)
        page.goto(BASE_URL, wait_until="domcontentloaded")

        page.get_by_label("Логин").fill("owner")
        page.get_by_label("Пароль").fill("correct-horse-battery-staple")
        page.get_by_role("button", name="Войти").click()
        page.get_by_role("heading", name="Переносимый чат").wait_for()

        page.get_by_label("Вопросы Codex").wait_for()
        secret = page.get_by_label("Секрет: ответ")
        if secret.get_attribute("type") != "password":
            raise AssertionError("secret user input is not rendered as a password field")
        secret.fill("browser-only-secret")
        page.get_by_role("button", name="Ответить").click()
        page.get_by_label("Вопросы Codex").wait_for(state="detached")
        if resolved_user_input != {"answers": {"secret": {"answers": ["browser-only-secret"]}}}:
            raise AssertionError("user-input response body does not match the typed protocol")
        if page.get_by_text("browser-only-secret").count():
            raise AssertionError("secret answer was rendered after submission")

        page.get_by_label("Запрос дополнительных прав").wait_for()
        page.get_by_role("button", name="Разрешить один раз").click()
        page.get_by_label("Запрос дополнительных прав").wait_for(state="detached")
        if resolved_permission != {"decision": "grant", "scope": "turn"}:
            raise AssertionError("permission response is not constrained to one turn")

        page.get_by_label("Архивировать чат").click()
        page.get_by_text("Здесь пока нет чатов.").wait_for()
        page.get_by_label("Меню проекта Demo").click()
        page.get_by_role("button", name="Архивированные чаты").click()
        page.get_by_label("Архивированные чаты").wait_for()
        page.get_by_role("strong").filter(has_text="Переносимый чат").wait_for()
        page.get_by_label("Восстановить чат").click()
        page.get_by_text("Архив пуст.").wait_for()

        page.set_viewport_size({"width": 390, "height": 844})
        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        if overflow:
            raise AssertionError("mobile layout has horizontal page overflow")
        unexpected_console_errors = [
            error
            for error in console_errors
            if "401 (Unauthorized)" not in error
        ]
        if unexpected_console_errors:
            raise AssertionError(f"browser console errors: {unexpected_console_errors}")
        browser.close()

    print(
        "browser-smoke: login, secret user-input, one-turn permission, archive/restore, mobile layout passed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

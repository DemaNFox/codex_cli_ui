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
                    "projectRoots": ["/srv/projects"],
                    "skills": [
                        {
                            "name": "multi-agent-orchestrator",
                            "path": "/srv/codex/skills/multi-agent-orchestrator",
                            "enabled": True,
                        }
                    ],
                    "rateLimits": [
                        {
                            "limitId": "codex",
                            "limitName": "Codex",
                            "planType": "plus",
                            "primary": {
                                "usedPercent": 31,
                                "windowDurationMins": 300,
                                "resetsAt": 1800000000,
                            },
                            "secondary": None,
                        }
                    ],
                    "usage": {
                        "summary": {
                            "lifetimeTokens": 123456,
                            "currentStreakDays": 4,
                            "longestStreakDays": 8,
                            "peakDailyTokens": 23456,
                            "longestRunningTurnSec": 321,
                        },
                        "dailyUsageBuckets": None,
                    },
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
                    "events": [
                        {
                            "id": index,
                            "threadId": "t1",
                            "turnId": f"history-{index}",
                            "kind": "agent-message",
                            "phase": "completed",
                            "payload": {
                                "text": f"Историческое сообщение {index}: длинный чат остаётся прокручиваемым."
                            },
                            "createdAt": "2026-09-27T11:59:00.000Z",
                        }
                        for index in range(1, 49)
                    ],
                },
            )
        elif path == "/api/threads/t1/attachments" and request.method == "GET":
            payload(route, 200, {"data": []})
        elif path == "/api/threads/t1/archive":
            archived = True
            payload(route, 200, {"data": {"id": "t1", "archived": True}})
        elif path == "/api/threads/t1/unarchive":
            archived = False
            payload(route, 200, {"data": {"id": "t1", "archived": False}})
        elif path == "/api/threads/t1/events":
            events = [
                {
                    "id": 101,
                    "threadId": "t1",
                    "turnId": None,
                    "kind": "thread",
                    "phase": "state",
                    "payload": {"status": "active"},
                    "createdAt": "2026-09-27T12:00:00.000Z",
                },
                {
                    "id": 102,
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "kind": "tool",
                    "phase": "started",
                    "payload": {
                        "item": {"id": "tool-1", "type": "mcpToolCall", "name": "GitHub"}
                    },
                    "createdAt": "2026-09-27T12:00:00.100Z",
                },
                {
                    "id": 103,
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "kind": "tool",
                    "phase": "completed",
                    "payload": {"item": {"id": "tool-1", "status": "completed"}},
                    "createdAt": "2026-09-27T12:00:00.200Z",
                },
                {
                    "id": 104,
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "kind": "command",
                    "phase": "completed",
                    "payload": {"command": "pnpm test", "output": "All tests passed"},
                    "createdAt": "2026-09-27T12:00:00.300Z",
                },
                {
                    "id": 105,
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
                    "id": 106,
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

        page.get_by_text("GitHub").wait_for()
        if page.locator(".activity-card").count():
            raise AssertionError("legacy activity cards are still rendered")
        if page.get_by_text("Состояние чата").count():
            raise AssertionError("thread lifecycle noise is still rendered")
        if page.get_by_text("Использует инструмент").count():
            raise AssertionError("completed tool lifecycle was not collapsed")
        command_row = page.locator("details.activity-row").filter(has_text="Выполнил команду")
        command_row.get_by_text("Выполнил команду").click()
        command_row.get_by_text("All tests passed").wait_for()

        if page.get_by_label("Навигация").count() != 1:
            raise AssertionError("workspace must use one unified navigation sidebar")
        transcript_metrics = page.locator(".conversation-scroll").evaluate(
            "element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight})"
        )
        if transcript_metrics["scrollHeight"] <= transcript_metrics["clientHeight"]:
            raise AssertionError("long transcript is not isolated in its own scroll container")
        composer_box = page.locator(".composer-wrap").bounding_box()
        if not composer_box or composer_box["y"] + composer_box["height"] > 900:
            raise AssertionError("composer is pushed below the desktop viewport")

        composer = page.get_by_label("Сообщение Codex")
        composer.fill("/sta")
        page.get_by_role("listbox", name="Команды Codex").wait_for()
        page.get_by_role("option", name="/status Статус, лимиты и использование").click()
        composer.press("Enter")
        page.get_by_label("Статус Codex").wait_for()
        page.get_by_text("31% использовано · 300 мин.").wait_for()
        page.get_by_text("multi-agent-orchestrator", exact=True).wait_for()
        page.get_by_label("Закрыть диагностику").click()

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

        project_menu = page.get_by_label("Меню проекта Demo")
        project_menu.click()
        archived_action = page.get_by_role("menuitem", name="Архивированные чаты")
        archived_action.wait_for(state="visible")
        menu_box = archived_action.bounding_box()
        if not menu_box or menu_box["x"] < 0 or menu_box["x"] + menu_box["width"] > 1440:
            raise AssertionError("project context menu is clipped on desktop")
        page.keyboard.press("Escape")

        page.get_by_label("Меню чата проекта Переносимый чат").click()
        page.get_by_role("menuitem", name="Архивировать чат").click()
        page.get_by_text("Здесь пока нет чатов.").wait_for()
        page.get_by_label("Меню проекта Demo").click()
        page.get_by_role("menuitem", name="Архивированные чаты").click()
        page.get_by_text("Архив", exact=True).wait_for()
        page.get_by_role("strong").filter(has_text="Переносимый чат").wait_for()
        page.get_by_label("Меню чата проекта Переносимый чат").click()
        page.get_by_role("menuitem", name="Восстановить чат").click()
        page.get_by_text("Архив пуст.").wait_for()

        page.set_viewport_size({"width": 390, "height": 600})
        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        if overflow:
            raise AssertionError("mobile layout has horizontal page overflow")

        navigation = page.get_by_label("Навигация")
        navigation.wait_for(state="hidden")
        page.get_by_role("button", name="Открыть навигацию").click()
        navigation.wait_for(state="visible")
        page.wait_for_function(
            "() => document.getElementById('workspace-navigation')?.contains(document.activeElement)"
        )
        page.wait_for_function(
            "() => (document.getElementById('workspace-navigation')?.getBoundingClientRect().x ?? -1) >= -0.5"
        )
        if not navigation.evaluate("element => element.contains(document.activeElement)"):
            raise AssertionError("mobile navigation did not receive keyboard focus")
        navigation_box = navigation.bounding_box()
        if (
            not navigation_box
            or navigation_box["x"] < -1
            or navigation_box["x"] + navigation_box["width"] > 391
        ):
            raise AssertionError(f"mobile navigation drawer is outside the viewport: {navigation_box}")
        logout = page.get_by_role("button", name="Выйти")
        logout.scroll_into_view_if_needed()
        logout_box = logout.bounding_box()
        if not logout_box or logout_box["y"] < 0 or logout_box["y"] + logout_box["height"] > 600:
            raise AssertionError("mobile drawer does not expose the session logout control")
        page.keyboard.press("Shift+Tab")
        if not navigation.evaluate("element => element.contains(document.activeElement)"):
            raise AssertionError("keyboard focus escaped the mobile navigation drawer")
        page.keyboard.press("Escape")
        navigation.wait_for(state="hidden")
        page.wait_for_function(
            "() => document.querySelector('.mobile-nav-toggle') === document.activeElement"
        )
        if not page.get_by_role("button", name="Открыть навигацию").evaluate(
            "element => element === document.activeElement"
        ):
            raise AssertionError("mobile navigation did not restore focus to its toggle")
        page.get_by_role("button", name="Открыть навигацию").click()
        navigation.wait_for(state="visible")
        page.locator(".project-button").click()
        page.locator(".project-button").click()
        navigation.wait_for(state="hidden")
        page.get_by_role("heading", name="Переносимый чат").wait_for()

        mobile_transcript = page.locator(".conversation-scroll").evaluate(
            "element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight})"
        )
        if mobile_transcript["clientHeight"] < 240:
            raise AssertionError("mobile transcript has too little usable height")
        if mobile_transcript["scrollHeight"] <= mobile_transcript["clientHeight"]:
            raise AssertionError("long mobile transcript is not independently scrollable")

        runtime_toggle = page.get_by_role("button", name="Параметры", exact=False)
        if runtime_toggle.get_attribute("aria-expanded") != "false":
            raise AssertionError("mobile runtime settings must be collapsed initially")
        runtime_toggle.click()
        for label in ("Модель", "Уровень reasoning", "Уровень доступа", "Политика подтверждений"):
            control = page.get_by_label(label)
            box = control.bounding_box()
            if not box or box["x"] < 0 or box["x"] + box["width"] > 390:
                raise AssertionError(f"mobile control is outside the viewport: {label}")
        runtime_toggle.click()
        mobile_composer = page.locator(".composer-wrap").bounding_box()
        if not mobile_composer or mobile_composer["y"] + mobile_composer["height"] > 600:
            raise AssertionError("composer is pushed below the constrained mobile viewport")

        composer.fill("/sta")
        mobile_palette = page.get_by_role("listbox", name="Команды Codex")
        mobile_palette.wait_for(state="visible")
        palette_box = mobile_palette.bounding_box()
        if not palette_box or palette_box["y"] < 0 or palette_box["y"] + palette_box["height"] > 600:
            raise AssertionError("mobile slash-command palette is clipped outside the viewport")
        page.get_by_role("option", name="/status Статус, лимиты и использование").click()
        composer.press("Enter")
        page.get_by_label("Статус Codex").wait_for()
        page.get_by_label("Закрыть диагностику").click()

        page.set_viewport_size({"width": 390, "height": 780})
        if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
            raise AssertionError("tall mobile layout has horizontal page overflow")
        tall_transcript_height = page.locator(".conversation-scroll").evaluate(
            "element => element.clientHeight"
        )
        if tall_transcript_height < 400:
            raise AssertionError("tall mobile layout does not give the transcript enough height")
        tall_composer = page.locator(".composer-wrap").bounding_box()
        if not tall_composer or tall_composer["y"] + tall_composer["height"] > 780:
            raise AssertionError("composer is pushed below the tall mobile viewport")
        unexpected_console_errors = [
            error
            for error in console_errors
            if "401 (Unauthorized)" not in error
        ]
        if unexpected_console_errors:
            raise AssertionError(f"browser console errors: {unexpected_console_errors}")
        browser.close()

    print(
        "browser-smoke: unified sidebar, long-chat scroll, status/skills, archive/restore and constrained layout passed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

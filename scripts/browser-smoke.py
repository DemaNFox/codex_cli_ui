#!/usr/bin/env python3
"""Isolated Playwright smoke for the login and per-project archive workflow."""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
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
    thread_name = "Переносимый чат"
    console_errors: list[str] = []
    resolved_user_input: dict[str, object] | None = None
    resolved_permission: dict[str, object] | None = None
    active_turn_attachment_uploaded = False
    active_turn_steer: dict[str, object] | None = None
    push_subscribed = False
    push_endpoint = "https://push.example/smoke-device"
    account_login_pending = False
    codex_update_state = "ready"
    queued_turn_visible = True
    resource_snapshot = {
        "capacity": {
            "cpuCores": 8,
            "memoryBytes": 16 * 1024**3,
            "memoryAvailableBytes": 10 * 1024**3,
            "tasks": 1024,
            "measuredAt": "2026-09-28T10:00:00.000Z",
        },
        "desired": {
            "mode": "auto",
            "cpuCores": None,
            "memoryBytes": None,
            "tasks": None,
            "maxParallelAgents": None,
        },
        "effective": {
            "cpuCores": 8,
            "memoryBytes": 16 * 1024**3,
            "tasks": 1024,
            "maxParallelAgents": 4,
        },
        "state": "applied",
        "version": 1,
        "updatedAt": "2026-09-28T10:00:00.000Z",
        "appliedAt": "2026-09-28T10:00:00.000Z",
        "warning": None,
    }

    def api(route: Route) -> None:
        nonlocal signed_in, archived, thread_name, resolved_user_input, resolved_permission
        nonlocal active_turn_attachment_uploaded, active_turn_steer
        nonlocal push_subscribed
        nonlocal account_login_pending
        nonlocal codex_update_state
        nonlocal resource_snapshot
        nonlocal queued_turn_visible
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
        elif path == "/api/preferences/runtime":
            requested = request.post_data_json if request.method == "PUT" else {
                "model": "gpt-6-astra",
                "reasoningEffort": "high",
                "permissionPreset": "full-access",
                "approvalPolicy": "on-request",
            }
            payload(
                route,
                200,
                {"data": {**requested, "updatedAt": "2026-09-27T12:00:00.000Z"}},
            )
        elif path == "/api/system/capabilities":
            payload(
                route,
                200,
                {
                    "codexVersion": "codex-cli 0.153.4",
                    "appServerReady": True,
                    "authenticated": True,
                    "account": {
                        "type": "chatgpt",
                        "email": "owner@example.test",
                        "planType": "plus",
                    },
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
                        "dailyUsageBuckets": [
                            {
                                "startDate": (
                                    date.today() - timedelta(days=index)
                                ).isoformat(),
                                "tokens": 23456 if index == 6 else index + 1,
                            }
                            for index in range(30)
                        ],
                    },
                    "threadUsage": {
                        "threadId": "t1",
                        "estimated": True,
                        "inputTokens": 120000,
                        "cachedInputTokens": 90000,
                        "netNewInputTokens": 30000,
                        "outputTokens": 12000,
                        "totalTokens": 132000,
                    }
                    if query.get("threadId") == ["t1"]
                    else None,
                    "transcription": {
                        "available": True,
                        "model": "onnx-community/whisper-base",
                        "maxBytes": 10485760,
                        "maxDurationSeconds": 120,
                    },
                    "notifications": {
                        "available": True,
                        "vapidPublicKey": "BEl62iUYgUivxIkv69yViEuiBIa40HI4o2TjDqFr6BkDHRMYitVCCfZwzVQHBGEY",
                    },
                    "warnings": [],
                },
            )
        elif path == "/api/system/codex-account/login" and request.method == "POST":
            if request.post_data_json != {"type": "chatgptDeviceCode"}:
                raise AssertionError("account login did not use the bounded device-code request")
            account_login_pending = True
            payload(
                route,
                202,
                {
                    "data": {
                        "state": "pending",
                        "loginId": "smoke-login",
                        "userCode": "SMOK-TEST",
                        "verificationUrl": "https://auth.openai.com/device",
                        "expiresAt": "2027-01-01T00:15:00.000Z",
                        "message": None,
                    }
                },
            )
        elif path == "/api/system/codex-update" and request.method == "GET":
            if codex_update_state == "applying":
                codex_update_state = "current"
            payload(
                route,
                200,
                {
                    "data": {
                        "state": codex_update_state,
                        "currentVersion": (
                            "codex-cli 0.154.0"
                            if codex_update_state == "current"
                            else "codex-cli 0.153.4"
                        ),
                        "availableVersion": (
                            "codex-cli 0.154.0"
                            if codex_update_state in {"ready", "applying"}
                            else None
                        ),
                        "candidateReleaseId": (
                            "release-154" if codex_update_state in {"ready", "applying"} else None
                        ),
                        "lastResult": (
                            {
                                "status": "succeeded",
                                "message": "Codex updated",
                                "completedAt": "2026-10-01T10:00:00.000Z",
                            }
                            if codex_update_state == "current"
                            else None
                        ),
                    }
                },
            )
        elif path == "/api/system/codex-update/discovery" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": {
                        "state": "available",
                        "currentVersion": "codex-cli 0.153.4",
                        "latestVersion": "codex-cli 0.159.3",
                        "checkedAt": "2026-10-01T10:00:00.000Z",
                    }
                },
            )
        elif path == "/api/system/codex-update/check" and request.method == "POST":
            if request.post_data_json != {}:
                raise AssertionError("Codex version check must not accept client options")
            if request.headers.get("x-csrf-token") != "csrf-smoke":
                raise AssertionError("Codex version check did not carry CSRF protection")
            payload(
                route,
                200,
                {
                    "data": {
                        "state": "available",
                        "currentVersion": "codex-cli 0.153.4",
                        "latestVersion": "codex-cli 0.159.3",
                        "checkedAt": "2026-10-01T10:01:00.000Z",
                    }
                },
            )
        elif path == "/api/system/codex-update/apply" and request.method == "POST":
            if request.post_data_json != {}:
                raise AssertionError("Codex update request must not accept client options")
            if request.headers.get("x-csrf-token") != "csrf-smoke":
                raise AssertionError("Codex update request did not carry CSRF protection")
            codex_update_state = "applying"
            payload(
                route,
                202,
                {
                    "data": {
                        "state": "applying",
                        "currentVersion": "codex-cli 0.153.4",
                        "availableVersion": "codex-cli 0.154.0",
                        "candidateReleaseId": "release-154",
                        "lastResult": None,
                    }
                },
            )
        elif path == "/api/system/codex-account/login" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": {
                        "state": "pending" if account_login_pending else "idle",
                        "loginId": "smoke-login" if account_login_pending else None,
                        "userCode": "SMOK-TEST" if account_login_pending else None,
                        "verificationUrl": "https://auth.openai.com/device" if account_login_pending else None,
                        "expiresAt": "2027-01-01T00:15:00.000Z" if account_login_pending else None,
                        "message": None,
                    }
                },
            )
        elif path == "/api/system/codex-account/login" and request.method == "DELETE":
            account_login_pending = False
            payload(
                route,
                200,
                {
                    "data": {
                        "state": "idle",
                        "loginId": None,
                        "userCode": None,
                        "verificationUrl": None,
                        "expiresAt": None,
                        "message": None,
                    }
                },
            )
        elif path == "/api/threads/t1/push-subscriptions/status":
            push_subscribed = push_subscribed and request.post_data_json["endpoint"] == push_endpoint
            payload(route, 200, {"data": {"subscribed": push_subscribed}})
        elif path == "/api/threads/t1/push-subscriptions" and request.method == "PUT":
            push_subscribed = request.post_data_json["endpoint"] == push_endpoint
            payload(route, 200, {"data": {"subscribed": push_subscribed}})
        elif path == "/api/threads/t1/push-subscriptions" and request.method == "DELETE":
            if request.post_data_json["endpoint"] == push_endpoint:
                push_subscribed = False
            route.fulfill(status=204, body="")
        elif path == "/api/system/resource-limits" and request.method == "GET":
            payload(route, 200, {"data": resource_snapshot})
        elif path == "/api/system/resource-limits" and request.method == "PUT":
            requested = request.post_data_json
            resource_snapshot = {
                **resource_snapshot,
                "desired": requested["desired"],
                "state": "pending-idle",
                "version": resource_snapshot["version"] + 1,
                "updatedAt": "2026-09-28T10:01:00.000Z",
            }
            payload(route, 200, {"data": resource_snapshot})
        elif path == "/api/system/resource-limits/apply" and request.method == "POST":
            payload(route, 202, {"data": resource_snapshot})
        elif path == "/api/threads" and request.method == "GET":
            wants_archived = query.get("archived", ["false"])[0] == "true"
            visible = wants_archived == archived
            payload(
                route,
                200,
                {
                    "data": ([
                        {
                            "id": "t1",
                            "projectId": "p1",
                            "name": thread_name,
                            "preview": "Проверка архива",
                            "archived": archived,
                            "status": "idle",
                            "activeTurnId": None,
                            "model": "gpt-6-astra",
                            "reasoningEffort": "high",
                            "permissionPreset": "workspace-write",
                            "approvalPolicy": "on-request",
                            "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                            "createdAt": "2026-09-27T12:00:00.000Z",
                            "updatedAt": "2026-09-27T12:00:00.000Z",
                        }
                    ] if visible else []) + ([
                        {
                            "id": "t2",
                            "projectId": "p1",
                            "name": "Фоновая задача",
                            "preview": "Проверка индикатора",
                            "archived": False,
                            "status": "active",
                            "activeTurnId": "turn-background",
                            "model": "gpt-6-astra",
                            "reasoningEffort": "high",
                            "permissionPreset": "workspace-write",
                            "approvalPolicy": "on-request",
                            "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                            "createdAt": "2026-09-27T12:01:00.000Z",
                            "updatedAt": "2026-09-27T12:01:00.000Z",
                        }
                    ] if visible and not wants_archived else [])
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
                        "name": thread_name,
                        "preview": "Проверка архива",
                        "archived": archived,
                        "status": "idle",
                        "activeTurnId": None,
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
                            "id": 0,
                            "threadId": "t1",
                            "turnId": "history-0",
                            "kind": "user-message",
                            "phase": "completed",
                            "payload": {
                                "text": "Проверка_очень_длинной_неразрывной_строки_которая_не_должна_расширять_мобильный_чат_за_границы_экрана",
                                "attachments": [
                                    {
                                        "id": f"attachment-{attachment_index}",
                                        "threadId": "t1",
                                        "name": f"{attachment_index:02d}_очень-длинное-название-вложения-которое-не-должно-ломать-мобильную-верстку.md",
                                        "mediaType": "text/markdown",
                                        "kind": "file",
                                        "sizeBytes": 4096,
                                        "createdAt": "2026-09-27T11:58:00.000Z",
                                        "url": f"/api/threads/t1/attachments/attachment-{attachment_index}",
                                    }
                                    for attachment_index in range(1, 4)
                                ],
                            },
                            "createdAt": "2026-09-27T11:58:00.000Z",
                        }
                    ]
                    + [
                        {
                            "id": index,
                            "threadId": "t1",
                            "turnId": "history-0" if index <= 2 else f"history-{index}",
                            "kind": "agent-message",
                            "phase": "completed",
                            "payload": {
                                "text": (
                                    "Промежуточный отчёт, который должен скрыться после завершения."
                                    if index == 1
                                    else
                                    "| Контур | Получено | Подтверждено | Причина остатка |\n"
                                    "| --- | ---: | ---: | --- |\n"
                                    "| Вчера | 196 | 114 | Подтверждение ещё не получено |\n"
                                    "| Сегодня | 150 | 82 | Проверка и повторная отправка |"
                                    "\n\n[Скачать отчёт](reports/audit.md)"
                                    " · [Скачать пропавший отчёт](reports/missing.md)"
                                    "\n\n```text\nvery-long-code-value-without-breaks-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n```"
                                    if index == 2
                                    else f"Историческое сообщение {index}: длинный чат остаётся прокручиваемым."
                                ),
                                **(
                                    {"messagePhase": "commentary"}
                                    if index == 1
                                    else {"messagePhase": "final_answer"}
                                    if index == 2
                                    else {}
                                ),
                            },
                            "createdAt": "2026-09-27T11:59:00.000Z",
                        }
                        for index in range(1, 49)
                    ]
                    + [
                        {
                            "id": 49,
                            "threadId": "t1",
                            "turnId": "history-0",
                            "kind": "turn",
                            "phase": "completed",
                            "payload": {"status": "completed"},
                            "createdAt": "2026-09-27T11:59:01.000Z",
                        },
                        {
                            "id": 50,
                            "threadId": "t1",
                            "turnId": "turn-1",
                            "kind": "user-message",
                            "phase": "completed",
                            "payload": {"text": "Проверить активную задачу"},
                            "createdAt": "2026-09-27T11:59:02.000Z",
                        }
                    ],
                    "queuedTurns": (
                        [
                            {
                                "id": 17,
                                "threadId": "t1",
                                "status": "queued",
                                "position": 1,
                                "errorCode": None,
                                "textPreview": "Запустить после освобождения безопасного слота",
                                "attachmentCount": 1,
                                "createdAt": "2026-09-27T12:00:03.000Z",
                            }
                        ]
                        if os.environ.get("CODEX_WEB_LAYOUT_ONLY") == "1" and queued_turn_visible
                        else []
                    ),
                },
            )
        elif path == "/api/threads/t1/queued-turns" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": (
                        [
                            {
                                "id": 17,
                                "threadId": "t1",
                                "status": "queued",
                                "position": 1,
                                "errorCode": None,
                                "textPreview": "Запустить после освобождения безопасного слота",
                                "attachmentCount": 1,
                                "createdAt": "2026-09-27T12:00:03.000Z",
                            }
                        ]
                        if os.environ.get("CODEX_WEB_LAYOUT_ONLY") == "1" and queued_turn_visible
                        else []
                    )
                },
            )
        elif path == "/api/threads/t1/queued-turns/17" and request.method == "DELETE":
            if request.headers.get("x-csrf-token") != "csrf-smoke":
                raise AssertionError("queued turn cancellation did not carry CSRF protection")
            queued_turn_visible = False
            route.fulfill(status=204, body="")
        elif path == "/api/threads/t2" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": {
                        "id": "t2",
                        "projectId": "p1",
                        "name": "Фоновая задача",
                        "preview": "Проверка индикатора",
                        "archived": False,
                        "status": "active",
                        "activeTurnId": "turn-background",
                        "model": "gpt-6-astra",
                        "reasoningEffort": "high",
                        "permissionPreset": "workspace-write",
                        "approvalPolicy": "on-request",
                        "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                        "createdAt": "2026-09-27T12:01:00.000Z",
                        "updatedAt": "2026-09-27T12:01:00.000Z",
                    },
                    "events": [
                        {
                            "id": 1,
                            "threadId": "t2",
                            "turnId": "turn-background",
                            "kind": "user-message",
                            "phase": "completed",
                            "payload": {"text": "Продолжай фоновую проверку"},
                            "createdAt": "2026-09-27T12:01:00.000Z",
                        },
                        {
                            "id": 2,
                            "threadId": "t2",
                            "turnId": "turn-background",
                            "kind": "turn",
                            "phase": "started",
                            "payload": {"status": "inProgress"},
                            "createdAt": "2026-09-27T12:01:01.000Z",
                        },
                        {
                            "id": 3,
                            "threadId": "t2",
                            "turnId": "turn-background",
                            "kind": "agent-message",
                            "phase": "completed",
                            "payload": {
                                "text": "Ответ уже получен, но фоновая проверка продолжается.",
                                "messagePhase": "final_answer",
                            },
                            "createdAt": "2026-09-27T12:01:01.500Z",
                        },
                    ],
                },
            )
        elif path == "/api/threads/t2/attachments" and request.method == "GET":
            payload(route, 200, {"data": []})
        elif path == "/api/threads/t2/attachments" and request.method == "POST":
            if request.headers.get("x-csrf-token") != "csrf-smoke":
                raise AssertionError("active-turn attachment upload did not carry CSRF protection")
            if "active-turn-note.txt" not in (request.post_data or ""):
                raise AssertionError("active-turn attachment upload did not contain the selected file")
            active_turn_attachment_uploaded = True
            payload(
                route,
                201,
                {
                    "data": {
                        "id": "00000000-0000-4000-8000-000000000099",
                        "threadId": "t2",
                        "name": "active-turn-note.txt",
                        "mediaType": "text/plain",
                        "kind": "file",
                        "sizeBytes": 23,
                        "createdAt": "2026-09-27T12:02:00.000Z",
                        "url": "/api/threads/t2/attachments/00000000-0000-4000-8000-000000000099/content",
                    }
                },
            )
        elif path == "/api/threads/t2/subagents" and request.method == "GET":
            payload(route, 200, {"data": []})
        elif path == "/api/threads/t2/push-subscriptions/status":
            payload(route, 200, {"data": {"subscribed": False}})
        elif path == "/api/threads/t2/steer" and request.method == "POST":
            active_turn_steer = request.post_data_json
            payload(route, 202, {"data": {"turnId": "turn-background"}})
        elif path == "/api/threads/t2/events":
            event = {
                "id": 4,
                "threadId": "t2",
                "turnId": "turn-background",
                "kind": "thread",
                "phase": "state",
                "payload": {
                    "threadRuntime": {
                        "status": "active",
                        "activeTurnId": "turn-background",
                    }
                },
                "createdAt": "2026-09-27T12:01:02.000Z",
            }
            route.fulfill(
                status=200,
                content_type="text/event-stream",
                body=(
                    "retry: 60000\n"
                    f"id: {event['id']}\nevent: {event['kind']}\n"
                    f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                ),
            )
        elif path == "/api/threads/t1" and request.method == "PATCH":
            thread_name = request.post_data_json["name"]
            payload(
                route,
                200,
                {
                    "data": {
                        "id": "t1",
                        "projectId": "p1",
                        "name": thread_name,
                        "preview": "Проверка архива",
                        "archived": archived,
                        "status": "idle",
                        "activeTurnId": None,
                        "model": "gpt-6-astra",
                        "instructionSources": ["/srv/projects/demo/AGENTS.md"],
                        "createdAt": "2026-09-27T12:00:00.000Z",
                        "updatedAt": "2026-09-27T12:05:00.000Z",
                    }
                },
            )
        elif path == "/api/threads/t1/attachments" and request.method == "GET":
            payload(route, 200, {"data": []})
        elif path == "/api/threads/t1/project-files/download" and request.method == "HEAD":
            requested_file = parse_qs(parsed.query).get("path")
            if requested_file == ["reports/audit.md"]:
                route.fulfill(
                    status=200,
                    headers={
                        "content-type": "application/octet-stream",
                        "content-length": str(len("# Audit ready\n")),
                        "content-disposition": 'attachment; filename="audit.md"',
                        "x-content-type-options": "nosniff",
                        "cache-control": "private, no-store",
                    },
                    body="",
                )
            elif requested_file == ["reports/missing.md"]:
                route.fulfill(status=404, body="")
            else:
                route.fulfill(status=400, body="")
        elif path == "/api/threads/t1/project-files/download" and request.method == "GET":
            if parse_qs(parsed.query).get("path") != ["reports/audit.md"]:
                payload(route, 404, {"error": {"code": "PROJECT_FILE_NOT_FOUND"}})
            else:
                route.fulfill(
                    status=200,
                    headers={
                        "content-type": "application/octet-stream",
                        "content-disposition": "attachment; filename=\"audit.md\"",
                        "x-content-type-options": "nosniff",
                    },
                    body="# Audit ready\n",
                )
        elif path == "/api/threads/t1/subagents" and request.method == "GET":
            payload(
                route,
                200,
                {
                    "data": [
                        {
                            "id": "agent-ui",
                            "rootThreadId": "t1",
                            "parentThreadId": "t1",
                            "agentPath": "/root/ui",
                            "nickname": "Верстальщик",
                            "role": "Адаптивный интерфейс",
                            "model": "gpt-6-astra",
                            "reasoningEffort": "high",
                            "status": "running",
                            "message": "Проверяет интерфейс",
                            "startedAt": "2026-09-28T09:59:00.000Z",
                            "lastActivityAt": "2026-09-28T10:00:00.000Z",
                            "completedAt": None,
                        }
                    ]
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
                *[
                    {
                        "id": 97 + index,
                        "threadId": "t1",
                        "turnId": "turn-1",
                        "kind": "tool",
                        "phase": "completed",
                        "payload": {
                            "item": {
                                "id": f"reasoning-{index}",
                                "type": "reasoning",
                                "status": "completed",
                            }
                        },
                        "createdAt": f"2026-09-27T11:59:5{index}.000Z",
                    }
                    for index in range(4)
                ],
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
                    "kind": "tool",
                    "phase": "completed",
                    "payload": {
                        "item": {
                            "id": "command-1",
                            "type": "commandExecution",
                            "command": "pnpm test",
                            "aggregatedOutput": "All tests passed",
                        }
                    },
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
        page = browser.new_page(viewport={"width": 390, "height": 600})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.add_init_script(
            """
            (() => {
              const subscription = {
                endpoint: 'https://push.example/smoke-device',
                unsubscribe: async () => { throw new Error('global unsubscribe must not be called'); },
                toJSON: () => ({
                  endpoint: 'https://push.example/smoke-device',
                  expirationTime: null,
                  keys: { p256dh: 'public-key', auth: 'auth-key' },
                }),
              };
              let installed = false;
              const registration = {
                pushManager: {
                  getSubscription: async () => installed ? subscription : null,
                  subscribe: async () => { installed = true; return subscription; },
                },
              };
              class MockNotification {
                static permission = 'default';
                static async requestPermission() { this.permission = 'granted'; return 'granted'; }
              }
              Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification });
              Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
              Object.defineProperty(navigator, 'serviceWorker', {
                configurable: true,
                value: {
                  getRegistration: async () => installed ? registration : undefined,
                  register: async () => { installed = true; return registration; },
                  ready: Promise.resolve(registration),
                },
              });
            })();
            """
        )
        page.route("**/api/**", api)
        page.goto(BASE_URL, wait_until="domcontentloaded")
        if page.locator('link[rel="manifest"][href="/manifest.webmanifest"]').count() != 1:
            raise AssertionError("installable web app manifest is not linked")
        worker_source = page.request.get(f"{BASE_URL}/push-service-worker.js").text()
        hostile_notification = page.evaluate(
            """
            async ({ source }) => {
              const handlers = {};
              const shown = [];
              const scope = {
                location: { origin: window.location.origin },
                addEventListener: (type, handler) => { handlers[type] = handler; },
                registration: {
                  showNotification: async (title, options) => { shown.push({ title, options }); },
                },
                clients: { matchAll: async () => [], openWindow: async () => undefined },
              };
              new Function('self', source)(scope);
              let completion;
              handlers.push({
                data: { json: () => ({
                  threadId: '../unsafe',
                  threadName: 'Безопасный чат',
                  status: 'completed',
                  title: 'INJECTED TITLE',
                  body: 'PRIVATE TRANSCRIPT',
                  url: 'https://evil.example/steal',
                }) },
                waitUntil: (promise) => { completion = promise; },
              });
              await completion;
              return shown[0];
            }
            """,
            {"source": worker_source},
        )
        if hostile_notification != {
            "title": "Codex",
            "options": {
                "body": "Работа в чате завершена.",
                "tag": "codex-chat",
                "data": {"url": "/"},
            },
        }:
            raise AssertionError(
                f"push worker trusted unexpected or cross-origin payload fields: {hostile_notification}"
            )

        page.get_by_label("Логин").fill("owner")
        page.get_by_label("Пароль").fill("correct-horse-battery-staple")
        page.get_by_role("button", name="Войти").click()
        page.get_by_role("heading", name="Переносимый чат").wait_for()
        if os.environ.get("CODEX_WEB_LAYOUT_ONLY") == "1":
            queued_region = page.get_by_role("region", name="Задачи в очереди")
            queued_region.get_by_text(
                "Ожидает завершения текущей работы", exact=True
            ).wait_for()
            queued_region.get_by_text(
                "Запустить после освобождения безопасного слота", exact=True
            ).wait_for()
            queued_region.get_by_text("1 вложение", exact=True).wait_for()

        if page.evaluate("window.innerWidth") != 390:
            raise AssertionError("long chat was not opened with the mobile viewport")
        page.wait_for_timeout(500)
        mobile_open_metrics = page.locator(".conversation-scroll").evaluate(
            "element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop})"
        )
        if mobile_open_metrics["scrollHeight"] <= mobile_open_metrics["clientHeight"]:
            raise AssertionError("long mobile transcript is not independently scrollable")
        if (
            mobile_open_metrics["scrollHeight"]
            - mobile_open_metrics["scrollTop"]
            - mobile_open_metrics["clientHeight"]
            > 80
        ):
            raise AssertionError(
                f"mobile chat did not open at its latest message: metrics={mobile_open_metrics}"
            )
        jump_to_latest = page.get_by_role("button", name="Перейти к новым сообщениям")
        if jump_to_latest.count():
            raise AssertionError("scroll-to-latest control is visible when mobile chat opens at the bottom")
        conversation_scroll = page.locator(".conversation-scroll")
        conversation_scroll.hover()
        page.mouse.wheel(0, -10_000)
        page.wait_for_function(
            """() => {
                const element = document.querySelector('.conversation-scroll');
                return element && element.scrollTop <= 80;
            }"""
        )
        jump_to_latest.wait_for()
        jump_to_latest.click()
        page.wait_for_function(
            """() => {
                const element = document.querySelector('.conversation-scroll');
                return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
            }"""
        )
        if jump_to_latest.count():
            raise AssertionError("scroll-to-latest control remains visible at the bottom")

        conversation_scroll.press("PageUp")
        page.wait_for_function(
            """() => {
                const element = document.querySelector('.conversation-scroll');
                return element && element.scrollHeight - element.scrollTop - element.clientHeight > 80;
            }"""
        )
        jump_to_latest.wait_for()
        jump_to_latest.click()

        if os.environ.get("CODEX_WEB_LAYOUT_ONLY") == "1":
            cancel_queued = queued_region.get_by_role("button", name="Отменить задачу")
            cancel_box = cancel_queued.bounding_box()
            if (
                not cancel_box
                or cancel_box["x"] < 0
                or cancel_box["x"] + cancel_box["width"] > 390
            ):
                raise AssertionError(
                    f"queued cancellation is outside the mobile viewport: {cancel_box}"
                )
            if page.evaluate(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth"
            ):
                raise AssertionError("queued cancellation creates mobile horizontal overflow")
            cancel_queued.click()
            page.get_by_text("Задача отменена и удалена из очереди.", exact=True).wait_for()
            queued_region.wait_for(state="detached")

        page.set_viewport_size({"width": 1440, "height": 900})
        page.get_by_text("GitHub").wait_for()
        if page.get_by_label("Навигация").count() != 1:
            raise AssertionError("workspace must use one unified navigation sidebar")
        page.get_by_role(
            "button", name="Открыть чат проекта Фоновая задача — в работе"
        ).wait_for()
        if page.locator(".thread-running-dot").count() != 2:
            raise AssertionError("active chat indicator must appear in project and recent lists")
        page.get_by_role(
            "button", name="Открыть чат проекта Фоновая задача — в работе"
        ).click()
        page.get_by_role("heading", name="Фоновая задача").wait_for()
        active_answer = page.get_by_role(
            "article", name="Ответ получен · работа продолжается Codex"
        )
        active_answer.wait_for()
        if page.get_by_role("article", name="Итоговый ответ Codex").count():
            raise AssertionError("active final_answer was promoted before turn completion")
        active_file_picker = page.get_by_label("Выбрать вложения")
        if not active_file_picker.is_enabled():
            raise AssertionError("file picker is disabled while the root turn is active")
        active_file_picker.set_input_files(
            [
                {
                    "name": name,
                    "mimeType": "text/plain",
                    "buffer": f"{name}\n".encode(),
                }
                for name in [
                    "active-turn-note.txt",
                    "conversation-context-one.txt",
                    "conversation-context-two.txt",
                    "conversation-context-three.txt",
                ]
            ]
        )
        page.get_by_text("active-turn-note.txt", exact=True).wait_for()
        attachment_queue = page.get_by_label("Вложения к отправке")
        attachment_metrics = attachment_queue.evaluate(
            "element => ({scrollWidth: element.scrollWidth, clientWidth: element.clientWidth})"
        )
        if attachment_metrics["scrollWidth"] > attachment_metrics["clientWidth"] + 1:
            raise AssertionError(
                f"composer attachments require horizontal scrolling: {attachment_metrics}"
            )
        attachment_page_metrics = page.evaluate(
            "() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})"
        )
        if attachment_page_metrics["scrollWidth"] > attachment_page_metrics["clientWidth"] + 1:
            raise AssertionError(
                f"composer attachments widen the page: {attachment_page_metrics}"
            )
        for name in [
            "conversation-context-one.txt",
            "conversation-context-two.txt",
            "conversation-context-three.txt",
        ]:
            page.get_by_role("button", name=f"Удалить {name}").click()
        active_composer = page.get_by_label("Уточнение для активной задачи")
        active_composer.fill("Учти приложенный файл")
        page.get_by_role("button", name="Направить задачу").click()
        page.get_by_text("Уточнение принято активной задачей.", exact=True).wait_for()
        if not active_turn_attachment_uploaded:
            raise AssertionError("active-turn attachment was not uploaded before steer")
        if active_turn_steer != {
            "text": "Учти приложенный файл",
            "expectedTurnId": "turn-background",
            "attachmentIds": ["00000000-0000-4000-8000-000000000099"],
        }:
            raise AssertionError(
                f"active-turn steer did not carry its turn and attachment ids: {active_turn_steer}"
            )
        if page.get_by_label("Вложения к отправке").count():
            raise AssertionError("active-turn attachment queue was not cleared after accepted steer")
        page.get_by_role("button", name="Открыть чат проекта Переносимый чат").click()
        page.get_by_role("heading", name="Переносимый чат").wait_for()
        page.get_by_role("table").get_by_role("cell", name="Вчера").wait_for()
        if page.get_by_role("button", name="Голосовой ввод").count() != 1:
            raise AssertionError("voice input control is not available in the composer")
        agent_toggle = page.get_by_label("Агенты задачи: активных 1, всего 1")
        agent_toggle.click()
        agent_popover = page.get_by_label("Агенты задачи", exact=True)
        agent_popover.get_by_text("Верстальщик", exact=True).wait_for()
        agent_popover.get_by_text("Работает", exact=True).wait_for()
        popover_box = agent_popover.bounding_box()
        if (
            not popover_box
            or popover_box["x"] < 0
            or popover_box["x"] + popover_box["width"] > 1440
        ):
            raise AssertionError(f"agent popover is clipped on desktop: {popover_box}")
        agent_toggle.click()
        push_toggle = page.get_by_role("button", name="Включить уведомления для этого чата")
        push_toggle.click()
        page.get_by_role("button", name="Отключить уведомления для этого чата").wait_for()
        if not push_subscribed:
            raise AssertionError("push subscription was not mapped to the selected chat")
        page.get_by_role("button", name="Отключить уведомления для этого чата").click()
        page.get_by_role("button", name="Включить уведомления для этого чата").wait_for()
        if push_subscribed:
            raise AssertionError("push subscription mapping was not removed from the selected chat")
        transcript_metrics = page.locator(".conversation-scroll").evaluate(
            "element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop})"
        )
        if transcript_metrics["scrollHeight"] <= transcript_metrics["clientHeight"]:
            raise AssertionError("long transcript is not isolated in its own scroll container")
        page.wait_for_timeout(500)
        initial_metrics = page.locator(".conversation-scroll").evaluate(
            "element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop})"
        )
        if initial_metrics["scrollHeight"] - initial_metrics["scrollTop"] - initial_metrics["clientHeight"] > 80:
            raise AssertionError(
                f"existing chat did not open at its latest message: metrics={initial_metrics}, jump={page.get_by_role('button', name='Перейти к новым сообщениям').count()}"
            )
        if page.locator(".activity-card").count():
            raise AssertionError("legacy activity cards are still rendered")
        if page.get_by_text("Состояние чата").count():
            raise AssertionError("thread lifecycle noise is still rendered")
        if page.get_by_text("Использует инструмент").count():
            raise AssertionError("completed tool lifecycle was not collapsed")
        final_answer = page.get_by_role("article", name="Итоговый ответ Codex")
        final_answer.wait_for()
        if final_answer.count() != 1 or "Итоговый ответ" not in final_answer.inner_text():
            raise AssertionError("completed Codex answer is not visually identified as final")
        page.set_viewport_size({"width": 1048, "height": 1079})
        transcript_shell_box = page.locator(".transcript-shell").bounding_box()
        transcript_box = page.locator(".transcript").bounding_box()
        final_answer_box = final_answer.bounding_box()
        if (
            not transcript_shell_box
            or not transcript_box
            or not final_answer_box
            or transcript_box["width"] < transcript_shell_box["width"] * 0.85
            or final_answer_box["width"] < min(600, transcript_box["width"] * 0.75)
        ):
            raise AssertionError(
                "turn navigation collapsed the transcript column: "
                f"shell={transcript_shell_box}, transcript={transcript_box}, final={final_answer_box}"
            )
        page.set_viewport_size({"width": 1440, "height": 900})
        transcript_box = page.locator(".transcript").bounding_box()
        final_answer_box = final_answer.bounding_box()
        composer_box = page.locator(".composer").bounding_box()
        table_scroll = final_answer.locator(".markdown-table-scroll")
        table_metrics = table_scroll.evaluate(
            "element => ({scrollWidth: element.scrollWidth, clientWidth: element.clientWidth})"
        )
        code_metrics = final_answer.locator("pre").evaluate(
            "element => ({scrollWidth: element.scrollWidth, clientWidth: element.clientWidth})"
        )
        page_metrics = page.evaluate(
            "() => ({clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth})"
        )
        if (
            not transcript_box
            or not final_answer_box
            or not composer_box
            or final_answer_box["width"] < min(720, transcript_box["width"] * 0.75)
            or final_answer_box["width"] > 865
        ):
            raise AssertionError(
                "wide desktop reading column is not bounded but usable: "
                f"transcript={transcript_box}, final={final_answer_box}, composer={composer_box}"
            )
        left_gutter = final_answer_box["x"] - transcript_box["x"]
        right_gutter = (
            transcript_box["x"]
            + transcript_box["width"]
            - final_answer_box["x"]
            - final_answer_box["width"]
        )
        if left_gutter < 24 or abs(left_gutter - right_gutter) > 2:
            raise AssertionError(
                "wide desktop reading column does not have balanced adaptive gutters: "
                f"left={left_gutter}, right={right_gutter}"
            )
        if abs(composer_box["width"] - final_answer_box["width"]) > 2:
            raise AssertionError(
                "composer is not aligned with the reading column: "
                f"final={final_answer_box}, composer={composer_box}"
            )
        if page_metrics["scrollWidth"] > page_metrics["clientWidth"] + 1:
            raise AssertionError(f"wide desktop page overflows horizontally: {page_metrics}")
        if table_metrics["scrollWidth"] > table_metrics["clientWidth"] + 1:
            raise AssertionError(
                f"wide desktop result table still has horizontal overflow: {table_metrics}"
            )
        if code_metrics["scrollWidth"] > code_metrics["clientWidth"] + 1:
            raise AssertionError(
                f"wide desktop code block still has horizontal overflow: {code_metrics}"
            )
        if os.environ.get("CODEX_WEB_LAYOUT_ONLY") == "1":
            page.set_viewport_size({"width": 390, "height": 780})
            mobile_layout = page.evaluate(
                """
                () => ({
                  viewportWidth: document.documentElement.clientWidth,
                  pageWidth: document.documentElement.scrollWidth,
                  transcriptWidth: document.querySelector('.transcript')?.scrollWidth ?? 0,
                  transcriptClientWidth: document.querySelector('.transcript')?.clientWidth ?? 0,
                  tableViewportWidth: document.querySelector('.markdown-table-scroll')?.clientWidth ?? 0,
                  tableWidth: document.querySelector('.markdown-table-scroll')?.scrollWidth ?? 0,
                })
                """
            )
            if mobile_layout["pageWidth"] > mobile_layout["viewportWidth"] + 1:
                raise AssertionError(
                    f"mobile page overflows horizontally: {mobile_layout}"
                )
            if mobile_layout["transcriptWidth"] > mobile_layout["transcriptClientWidth"] + 1:
                raise AssertionError(
                    f"mobile transcript overflows horizontally: {mobile_layout}"
                )
            if mobile_layout["tableWidth"] <= mobile_layout["tableViewportWidth"]:
                raise AssertionError(
                    f"mobile result table lost its contained horizontal scroll: {mobile_layout}"
                )
            browser.close()
            print("browser-smoke: wide and mobile transcript layout passed")
            return 0
        generated_file = final_answer.get_by_role("link", name="Скачать отчёт")
        if generated_file.get_attribute("download") != "audit.md":
            raise AssertionError("generated project file is not marked as a download")
        unavailable_file = final_answer.get_by_text("Файл недоступен на сервере")
        unavailable_file.wait_for()
        if final_answer.get_by_role("link", name="Скачать пропавший отчёт").count():
            raise AssertionError("missing generated file is still presented as a download link")
        with page.expect_download() as generated_download:
            generated_file.click()
        if generated_download.value.suggested_filename != "audit.md":
            raise AssertionError(
                f"generated download filename changed: {generated_download.value.suggested_filename}"
            )
        if os.environ.get("CODEX_WEB_GENERATED_FILES_ONLY") == "1":
            browser.close()
            print("browser-smoke: generated file availability and controlled download passed")
            return 0
        if page.get_by_text("Промежуточный отчёт, который должен скрыться после завершения.").count():
            raise AssertionError("completed turn commentary remains visible after its final answer")
        turn_navigation = page.get_by_role("navigation", name="Переходы по задачам")
        turn_navigation.wait_for()
        if turn_navigation.get_by_role("button").count() != 2:
            raise AssertionError("turn navigation does not expose every user call")
        navigation_box = turn_navigation.bounding_box()
        if navigation_box is None:
            raise AssertionError("turn navigation geometry is unavailable")
        navigation_center = navigation_box["y"] + navigation_box["height"] / 2
        viewport_center = page.viewport_size["height"] / 2
        if abs(navigation_center - viewport_center) > 12:
            raise AssertionError(
                f"turn navigation is not centered in the window: navigation={navigation_box}, viewport={page.viewport_size}"
            )
        turn_navigation.get_by_role("button").first.click()
        if page.get_by_role("button", name="Перейти к новым сообщениям").count() != 1:
            raise AssertionError("turn navigation did not leave follow-latest mode")
        page.get_by_role("button", name="Перейти к новым сообщениям").evaluate(
            "element => element.click()"
        )
        activity_group = page.get_by_role("region", name="Ход работы: 6 действий")
        activity_group.wait_for()
        if activity_group.locator(".activity-row").count() != 3:
            raise AssertionError("collapsed activity group must show exactly three latest actions")
        activity_toggle = activity_group.locator(".activity-group-toggle")
        if "6 действий" not in activity_toggle.inner_text():
            raise AssertionError("activity spoiler does not expose the total action count")
        activity_toggle.click()
        if activity_group.locator(".activity-row").count() != 6:
            raise AssertionError("expanded activity group does not expose the full action history")
        command_row = page.locator("details.activity-row:visible").filter(
            has_text="Выполнил команду"
        )
        command_row.locator("summary").click()
        if not command_row.evaluate("element => element.open"):
            raise AssertionError("command activity disclosure did not open")
        if command_row.get_by_text("pnpm test").count() != 1:
            raise AssertionError("command activity preview is missing")
        command_row.get_by_text("All tests passed").wait_for()

        conversation_scroll = page.locator(".conversation-scroll")
        conversation_scroll.hover()
        page.mouse.wheel(0, -10_000)
        page.wait_for_function(
            """() => {
                const element = document.querySelector('.conversation-scroll');
                return element && element.scrollTop <= 80;
            }"""
        )
        jump_to_latest = page.get_by_role("button", name="Перейти к новым сообщениям")
        jump_to_latest.wait_for()
        jump_to_latest.click()
        page.wait_for_function(
            """() => {
                const element = document.querySelector('.conversation-scroll');
                return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
            }"""
        )
        if jump_to_latest.count():
            raise AssertionError("scroll-to-latest control remains visible at the bottom")
        first_time = page.locator(".message time").first
        first_time.wait_for()
        if first_time.get_attribute("datetime") != "2026-09-27T11:58:00.000Z":
            raise AssertionError("message timestamp lost its canonical server time")
        if page.get_by_label("Уровень доступа").input_value() != "full-access":
            raise AssertionError("server-owned runtime preferences were not restored")
        composer_box = page.locator(".composer-wrap").bounding_box()
        if not composer_box or composer_box["y"] + composer_box["height"] > 900:
            raise AssertionError("composer is pushed below the desktop viewport")

        composer = page.get_by_label("Сообщение Codex")
        textarea_box = composer.bounding_box()
        controls_box = page.locator(".composer-controls").bounding_box()
        textarea_padding = composer.evaluate(
            "element => ({left: parseFloat(getComputedStyle(element).paddingLeft), resize: getComputedStyle(element).resize})"
        )
        if not textarea_box or textarea_box["height"] > 60:
            raise AssertionError(f"empty composer is not compact: {textarea_box}")
        if not controls_box or controls_box["y"] < textarea_box["y"] + textarea_box["height"] - 1:
            raise AssertionError("composer controls overlap the text entry area")
        if textarea_padding["left"] > 20 or textarea_padding["resize"] != "none":
            raise AssertionError(f"composer text is offset or manually resizable: {textarea_padding}")
        composer.fill("one\ntwo\nthree\nfour")
        grown_box = composer.bounding_box()
        if not grown_box or grown_box["height"] <= textarea_box["height"]:
            raise AssertionError("composer did not grow with multiline text")
        composer.fill("")
        compact_box = composer.bounding_box()
        if not compact_box or compact_box["height"] > textarea_box["height"] + 1:
            raise AssertionError("composer did not return to compact height after clearing")

        composer.fill("/sta")
        page.get_by_role("listbox", name="Команды Codex").wait_for()
        page.get_by_role("option", name="/status Статус, лимиты и использование").click()
        composer.press("Enter")
        page.get_by_label("Статус Codex").wait_for()
        page.get_by_text("31% использовано · 300 мин.").wait_for()
        page.get_by_text("multi-agent-orchestrator", exact=True).wait_for()
        diagnostics = page.get_by_label("Статус Codex")
        current_chat_usage = diagnostics.get_by_role("heading", name="Текущий чат").locator("..")
        current_chat_usage.get_by_text("Переносимый чат", exact=True).wait_for()
        current_chat_usage.get_by_text("Оценка Codex по этому чату", exact=True).wait_for()
        current_chat_usage.get_by_text("132 000", exact=True).wait_for()
        account_usage = diagnostics.get_by_role("heading", name="Весь аккаунт Codex").locator("..")
        account_usage.get_by_text("Сегодня", exact=True).wait_for()
        account_usage.get_by_text("Последние 7 дней", exact=True).wait_for()
        account_usage.get_by_text("Последние 30 дней", exact=True).wait_for()
        account_usage.get_by_text("За всё доступное время", exact=True).wait_for()
        account_usage.get_by_text("23 477", exact=True).wait_for()
        account_usage.get_by_text("23 914", exact=True).wait_for()
        if os.environ.get("CODEX_WEB_USAGE_ONLY") == "1":
            page.set_viewport_size({"width": 390, "height": 780})
            mobile_usage = diagnostics.evaluate(
                """
                element => ({
                  viewportWidth: document.documentElement.clientWidth,
                  pageWidth: document.documentElement.scrollWidth,
                  drawerWidth: element.scrollWidth,
                  drawerClientWidth: element.clientWidth,
                })
                """
            )
            if mobile_usage["pageWidth"] > mobile_usage["viewportWidth"] + 1:
                raise AssertionError(
                    f"mobile usage page overflows horizontally: {mobile_usage}"
                )
            if mobile_usage["drawerWidth"] > mobile_usage["drawerClientWidth"] + 1:
                raise AssertionError(
                    f"mobile usage drawer overflows horizontally: {mobile_usage}"
                )
            browser.close()
            print("browser-smoke: chat and account usage scopes passed")
            return 0
        diagnostics.get_by_text("owner@example.test", exact=True).wait_for()
        diagnostics.get_by_text("Доступна новая версия Codex.", exact=False).wait_for()
        diagnostics.get_by_role("button", name="Проверить обновления").click()
        diagnostics.get_by_text("Проверено 01.10.2026, 13:01:00").wait_for()
        diagnostics.get_by_text("Обновление готово к установке.").wait_for()
        diagnostics.get_by_role("button", name="Обновить Codex").click()
        diagnostics.get_by_text("Обновляем Codex…").wait_for()
        diagnostics.get_by_text("Установлена актуальная подготовленная версия.").wait_for()
        diagnostics.get_by_text("codex-cli 0.154.0", exact=True).wait_for()
        if diagnostics.get_by_role("button", name="Обновить Codex").count():
            raise AssertionError("Codex update button remains after the prepared update completed")
        diagnostics.get_by_role("button", name="Сменить аккаунт").click()
        account_dialog = page.get_by_role("dialog", name="Смена аккаунта Codex")
        account_dialog.wait_for()
        account_dialog.get_by_label("Одноразовый код").get_by_text("SMOK-TEST").wait_for()
        if account_dialog.get_by_role("link", name="Открыть страницу входа").get_attribute("href") != "https://auth.openai.com/device":
            raise AssertionError("device login link is not the bounded OpenAI verification URL")
        account_box = account_dialog.bounding_box()
        if not account_box or account_box["x"] < 0 or account_box["x"] + account_box["width"] > 1440:
            raise AssertionError("account login dialog is outside the desktop viewport")
        page.keyboard.press("Escape")
        account_dialog.wait_for(state="detached")
        page.get_by_text("Смена аккаунта отменена. Текущий аккаунт сохранён.").wait_for()
        diagnostics.get_by_label("Настроить вручную").click()
        diagnostics.get_by_label("Лимит CPU, ядер").fill("4")
        diagnostics.get_by_role("button", name="Сохранить").click()
        diagnostics.get_by_text("Ожидает завершения текущих задач").wait_for()
        diagnostics.get_by_role("button", name="Применить").click()
        diagnostics.get_by_text("Ожидает завершения текущих задач").wait_for()
        if diagnostics.get_by_text("Применено", exact=True).count():
            raise AssertionError("pending resource apply was rendered as applied")
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
        page.get_by_role("menuitem", name="Переименовать").click()
        page.get_by_label("Название").fill("Релиз без обрыва")
        page.get_by_role("button", name="Сохранить").click()
        page.get_by_role("heading", name="Релиз без обрыва").wait_for()

        page.get_by_label("Меню чата проекта Релиз без обрыва").click()
        page.get_by_role("menuitem", name="Архивировать чат").click()
        page.get_by_text("Здесь пока нет чатов.").wait_for()
        if not page.get_by_label("Сообщение Codex").is_disabled():
            raise AssertionError("archiving the selected chat left its composer active")
        page.get_by_label("Меню проекта Demo").click()
        page.get_by_role("menuitem", name="Архивированные чаты").click()
        page.get_by_text("Архив", exact=True).wait_for()
        page.get_by_role("strong").filter(has_text="Релиз без обрыва").wait_for()
        page.get_by_label("Меню чата проекта Релиз без обрыва").click()
        page.get_by_role("menuitem", name="Восстановить чат").click()
        page.get_by_text("Архив пуст.").wait_for()
        page.get_by_role("button", name="Назад").click()
        page.get_by_role("heading", name="Релиз без обрыва").wait_for()

        page.set_viewport_size({"width": 390, "height": 600})
        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        if overflow:
            raise AssertionError("mobile layout has horizontal page overflow")
        agent_toggle.click()
        agent_popover.wait_for(state="visible")
        mobile_agent_box = agent_popover.bounding_box()
        if (
            not mobile_agent_box
            or mobile_agent_box["x"] < 0
            or mobile_agent_box["x"] + mobile_agent_box["width"] > 390
            or mobile_agent_box["y"] < 0
        ):
            raise AssertionError(f"agent popover is outside the mobile viewport: {mobile_agent_box}")
        if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
            raise AssertionError("open agent popover creates horizontal page overflow")
        agent_toggle.click()

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
        logout_box_before = logout.bounding_box()
        page.locator(".navigation-scroll").evaluate(
            """element => {
                const spacer = document.createElement('div');
                spacer.dataset.smokeSpacer = 'true';
                spacer.style.height = '2000px';
                element.append(spacer);
                element.scrollTop = element.scrollHeight;
            }"""
        )
        logout_box = logout.bounding_box()
        if (
            not logout_box_before
            or not logout_box
            or abs(logout_box["y"] - logout_box_before["y"]) > 1
            or logout_box["y"] < 0
            or logout_box["y"] + logout_box["height"] > 600
        ):
            raise AssertionError("mobile drawer does not expose the session logout control")
        page.locator('[data-smoke-spacer="true"]').evaluate("element => element.remove()")
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
        page.get_by_role("heading", name="Релиз без обрыва").wait_for()

        mobile_widths = page.locator(
            ".conversation-scroll, .transcript, .message, .message-attachments"
        ).evaluate_all(
            "elements => elements.map(element => ({className: element.className, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth}))"
        )
        overflowing = [
            item for item in mobile_widths if item["scrollWidth"] > item["clientWidth"] + 1
        ]
        if overflowing:
            raise AssertionError(f"mobile transcript content overflows horizontally: {overflowing}")

        page.get_by_role("button", name="Открыть навигацию").click()
        navigation.wait_for(state="visible")
        page.get_by_label("Меню чата проекта Релиз без обрыва").click()
        page.get_by_role("menuitem", name="Переименовать").click()
        rename_dialog = page.get_by_role("dialog", name="Переименовать чат")
        rename_box = rename_dialog.bounding_box()
        rename_input_box = page.get_by_label("Название").bounding_box()
        if (
            not rename_box
            or rename_box["x"] < 0
            or rename_box["x"] + rename_box["width"] > 390
            or not rename_input_box
            or rename_input_box["x"] < rename_box["x"]
            or rename_input_box["x"] + rename_input_box["width"] > rename_box["x"] + rename_box["width"]
        ):
            raise AssertionError(
                f"mobile rename dialog is outside the viewport: dialog={rename_box}, input={rename_input_box}"
            )
        page.get_by_role("button", name="Отмена").click()
        page.keyboard.press("Escape")
        navigation.wait_for(state="hidden")

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
        resource_box = page.locator(".resource-settings").bounding_box()
        if (
            not resource_box
            or resource_box["x"] < 0
            or resource_box["x"] + resource_box["width"] > 390
        ):
            raise AssertionError("mobile resource settings are outside the viewport")
        for label in (
            "Лимит CPU, ядер",
            "Лимит памяти, ГБ",
            "Лимит процессов",
            "Максимум параллельных агентов",
        ):
            field_box = page.get_by_label(label).bounding_box()
            if not field_box or field_box["x"] < 0 or field_box["x"] + field_box["width"] > 390:
                raise AssertionError(f"mobile resource control is outside the viewport: {label}")
        page.get_by_label("Статус Codex").get_by_role("button", name="Сменить аккаунт").click()
        mobile_account_dialog = page.get_by_role("dialog", name="Смена аккаунта Codex")
        mobile_account_dialog.wait_for()
        mobile_account_box = mobile_account_dialog.bounding_box()
        if (
            not mobile_account_box
            or mobile_account_box["x"] < 0
            or mobile_account_box["x"] + mobile_account_box["width"] > 390
        ):
            raise AssertionError("mobile account login dialog is outside the viewport")
        if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
            raise AssertionError("account login dialog creates horizontal mobile overflow")
        mobile_account_dialog.get_by_role("button", name="Отменить вход").click()
        mobile_account_dialog.wait_for(state="detached")
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
        "browser-smoke: active-turn attachments, account switching, resources, subagents, "
        "status, archive/restore and responsive layout passed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

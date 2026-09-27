from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class InfraStaticTest(unittest.TestCase):
    def test_systemd_unit_keeps_non_root_shared_host_boundary(self) -> None:
        unit = (ROOT / "infra/systemd/codex-web-ui@.service").read_text(encoding="utf-8")
        for expected in (
            "User=%i",
            "Wants=codex-web-ui-storage-guard@%i.timer",
            "ProtectSystem=strict",
            "NoNewPrivileges=yes",
            "CapabilityBoundingSet=",
            "MemoryMax=4G",
            "KillMode=control-group",
            "/run/docker.sock",
            "/opt/ai-chat-agents/state",
            "/opt/ai-chat-agent-release",
        ):
            self.assertIn(expected, unit)
        self.assertNotIn("User=root", unit)
        self.assertNotIn("SupplementaryGroups=docker", unit)

        guard_unit = (ROOT / "infra/systemd/codex-web-ui-storage-guard@.service").read_text(
            encoding="utf-8"
        )
        timer = (ROOT / "infra/systemd/codex-web-ui-storage-guard@.timer").read_text(
            encoding="utf-8"
        )
        self.assertIn("User=root", guard_unit)
        self.assertIn("codex-web-ui-storage-enforce %i", guard_unit)
        self.assertIn("OnUnitActiveSec=1min", timer)

    def test_nginx_edge_is_tls_only_for_application_traffic_and_sse_unbuffered(self) -> None:
        nginx = (ROOT / "infra/nginx/codex-web-ui.conf.template").read_text(encoding="utf-8")
        for expected in (
            "listen @@HTTP_PORT@@;",
            "listen @@HTTPS_PORT@@ ssl;",
            "return 301 https://$host:@@HTTPS_PORT@@$request_uri;",
            "ssl_protocols TLSv1.2 TLSv1.3;",
            "limit_req zone=codex_web_login",
            "proxy_buffering off;",
            "proxy_read_timeout 1h;",
            "Content-Security-Policy",
            "X-Content-Type-Options",
            "root /opt/codex-web-ui/current/apps/web/dist;",
            "try_files $uri $uri/ /index.html;",
        ):
            self.assertIn(expected, nginx)
        self.assertEqual(nginx.count("proxy_pass http://codex_web_backend;"), 3)
        static_route = nginx.split("location / {", 1)[1].split("}", 1)[0]
        self.assertIn("root /opt/codex-web-ui/current/apps/web/dist;", static_route)
        self.assertIn("try_files $uri $uri/ /index.html;", static_route)
        self.assertNotIn("proxy_pass", static_route)

        installer = (ROOT / "scripts/install-nginx.sh").read_text(encoding="utf-8")
        self.assertIn("--http-port", installer)
        self.assertIn("--https-port", installer)
        self.assertIn('HTTP and HTTPS edge ports must differ', installer)

    def test_environment_template_contains_no_populated_secret(self) -> None:
        environment = (ROOT / "infra/env/codex-web-ui.env.example").read_text(encoding="utf-8")
        for name in (
            "CODEX_WEB_ADMIN_USERNAME",
            "CODEX_WEB_ADMIN_PASSWORD_HASH",
            "CODEX_WEB_SESSION_SECRET",
        ):
            self.assertIn(f"{name}=\n", environment)
        self.assertIn('CODEX_WEB_CODEX_VERSION_PIN="codex-cli 0.153.4"', environment)
        self.assertIn("CODEX_WEB_MIN_FREE_BYTES=5368709120", environment)
        self.assertIn("CODEX_WEB_MAX_DATABASE_BYTES=2147483648", environment)
        self.assertIn("CODEX_WEB_MAX_RELEASES=5", environment)

    def test_install_update_and_rollback_keep_release_and_codex_state_boundaries(self) -> None:
        install_script = (ROOT / "scripts/install-ubuntu.sh").read_text(encoding="utf-8")
        update_script = (ROOT / "scripts/update-ubuntu.sh").read_text(encoding="utf-8")
        rollback_script = (ROOT / "scripts/rollback-ubuntu.sh").read_text(encoding="utf-8")
        common = (ROOT / "scripts/lib/ubuntu-common.sh").read_text(encoding="utf-8")
        self.assertIn("release source and CODEX_HOME must not overlap", common)
        self.assertIn("release source contains forbidden sensitive/runtime file", common)
        self.assertIn('apps/web/dist/index.html', common)
        self.assertIn("atomic_symlink", install_script)
        self.assertIn('chown root:root "$config"', install_script)
        self.assertIn('chmod 0600 "$config"', install_script)
        self.assertNotIn('chown root:"$service_group" "$config"', install_script)
        self.assertIn("--check-releases --additional-releases 1", install_script)
        self.assertIn("--check-releases --additional-releases 1", update_script)
        self.assertIn("previous-release", update_script)
        self.assertIn("restoring", update_script)
        self.assertIn("/opt/codex-web-ui/releases/*", rollback_script)
        self.assertNotIn("rm -rf", install_script + update_script + rollback_script)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class InfraStaticTest(unittest.TestCase):
    def test_systemd_unit_keeps_non_root_shared_host_boundary(self) -> None:
        unit = (ROOT / "infra/systemd/codex-web-ui@.service").read_text(encoding="utf-8")
        for expected in (
            "User=codex-web-ui-api",
            "Wants=codex-web-ui-storage-guard@%i.timer",
            "ProtectSystem=strict",
            "NoNewPrivileges=yes",
            "CapabilityBoundingSet=",
            "MemoryMax=4G",
            "KillMode=control-group",
            "ProtectProc=invisible",
            "PrivateTmp=no",
            "TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=1G,nr_inodes=16384,mode=1777",
            "TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=1G,nr_inodes=16384,mode=1777",
            "/run/docker.sock",
        ):
            self.assertIn(expected, unit)
        self.assertNotIn("User=root", unit)
        self.assertNotIn("SupplementaryGroups=docker", unit)
        self.assertNotIn("ProcSubset=pid", unit)

        runner = (ROOT / "infra/systemd/codex-web-ui-app-server@.service").read_text(
            encoding="utf-8"
        )
        socket = (ROOT / "infra/systemd/codex-web-ui-app-server.socket").read_text(
            encoding="utf-8"
        )
        self.assertIn("User=codex-web-ui-runner", runner)
        self.assertIn("EnvironmentFile=/etc/codex-web-ui/codex-runner.env", runner)
        self.assertIn("InaccessiblePaths=-/etc/codex-web-ui/codex-web-ui.env", runner)
        self.assertIn("ReadOnlyPaths=-/var/lib/codex-web-ui/data/attachments", runner)
        self.assertIn("Accept=yes", socket)
        self.assertIn("SocketMode=0600", socket)

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
            "listen @@HTTPS_PORT@@ ssl http2;",
            "return 301 https://$host:@@HTTPS_PORT@@$request_uri;",
            "ssl_protocols TLSv1.2 TLSv1.3;",
            "client_max_body_size 21m;",
            "client_body_timeout 60s;",
            "limit_req zone=codex_web_login",
            "proxy_buffering off;",
            "proxy_read_timeout 1h;",
            "Content-Security-Policy",
            "img-src 'self' data: blob:;",
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
        self.assertIn('TLS private key must be owned by root', installer)
        self.assertIn('openssl x509 -in "$tls_cert" -noout -checkhost "$domain"', installer)
        self.assertIn('previous configuration restored', installer)
        self.assertIn('trap rollback ERR', installer)

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
        self.assertIn("CODEX_WEB_APP_SERVER_SOCKET=/run/codex-web-ui/app-server.sock", environment)
        self.assertNotIn("CODEX_HOME=", environment)

    def test_portable_installer_has_explicit_secure_bootstrap(self) -> None:
        wrapper = (ROOT / "install.sh").read_text(encoding="utf-8")
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        bootstrap = (ROOT / "scripts/bootstrap-ubuntu.sh").read_text(encoding="utf-8")
        self.assertIn("prepare-package.sh", wrapper)
        self.assertIn("bootstrap-ubuntu.sh", wrapper)
        self.assertIn("pnpm install --frozen-lockfile", wrapper)
        self.assertIn("preflight_origin", wrapper)
        for expected in (
            'prepare-package.sh" --verify',
            "starting device login",
            "login --device-auth",
            "installation exists; rerun with --upgrade",
            "setup-admin.mjs",
            "--external-proxy",
            "codex-web-ui-app-server.socket",
            "changing the runner user requires an explicit migration workflow",
            "managed_codex_bin=",
            "an explicit --codex-home must already exist",
            "exec {tty_fd}<>/dev/tty",
            "runner_config_backup=",
            "load_toolchain_pins",
            "trap rollback_activation ERR INT TERM",
            "systemctl restart codex-web-ui-app-server.socket codex-web-ui@api.service",
            "--check-releases --additional-releases 1",
        ):
            self.assertIn(expected, installer)
        self.assertNotIn("http://", installer)
        self.assertNotIn('source "$PACKAGE_ROOT/infra/toolchain.env"', installer)
        self.assertNotIn('source "$REPO_ROOT/infra/toolchain.env"', bootstrap)
        for expected in (
            "NODE_LINUX_X64_SHA256",
            "PNPM_TARBALL_SHA512",
            "CODEX_LINUX_ARM64_TARBALL_SHA512",
            "https://nodejs.org/download/release/v${NODE_VERSION}",
            "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}.tgz",
            "sha256sum --check --strict --status",
            "sha512sum --check --strict --status",
            "/opt/codex-web-ui/runtime",
        ):
            self.assertIn(expected, bootstrap)
        self.assertNotIn("curl |", bootstrap)
        self.assertNotIn("@latest", bootstrap)
        self.assertNotIn("@alpha", bootstrap)

    def test_device_login_never_runs_as_root_or_captures_the_code(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        login_line = next(line for line in installer.splitlines() if 'login --device-auth <&' in line)
        self.assertIn('runuser -u "$runner_user"', login_line)
        self.assertIn('>&${tty_fd} 2>&${tty_fd}', login_line)
        self.assertIn("Never share the displayed device code", installer)

    def test_install_update_and_rollback_keep_release_and_codex_state_boundaries(self) -> None:
        install_script = (ROOT / "scripts/install-ubuntu.sh").read_text(encoding="utf-8")
        update_script = (ROOT / "scripts/update-ubuntu.sh").read_text(encoding="utf-8")
        rollback_script = (ROOT / "scripts/rollback-ubuntu.sh").read_text(encoding="utf-8")
        release_script = (ROOT / "scripts/prepare-release.sh").read_text(encoding="utf-8")
        health_script = (ROOT / "scripts/health-check.sh").read_text(encoding="utf-8")
        common = (ROOT / "scripts/lib/ubuntu-common.sh").read_text(encoding="utf-8")
        self.assertIn("release source and CODEX_HOME must not overlap", common)
        self.assertIn("release source contains forbidden sensitive/runtime file", common)
        self.assertIn('apps/web/dist/index.html', common)
        self.assertIn("atomic_symlink", install_script)
        self.assertIn('chown root:root "$config"', install_script)
        self.assertIn('chmod 0600 "$config"', install_script)
        self.assertIn('/usr/local/libexec', install_script)
        self.assertNotIn('chown root:"$service_group" "$config"', install_script)
        self.assertIn("--check-releases --additional-releases 1", install_script)
        self.assertIn("--check-releases --additional-releases 1", update_script)
        self.assertIn("previous-release", update_script)
        self.assertIn("restoring", update_script)
        self.assertIn("/opt/codex-web-ui/releases/*", rollback_script)
        self.assertNotIn("rm -rf", install_script + update_script + rollback_script)
        self.assertIn('@codex-web/server', release_script)
        self.assertIn('--config.inject-workspace-packages=true deploy --prod', release_script)
        self.assertIn("'@codex-web/contracts', '@fastify/cookie', 'argon2', 'fastify', 'zod'", release_script)
        self.assertNotIn('deploy --prod --legacy', release_script)
        self.assertIn('SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"', health_script)

    def test_runner_helper_requires_owned_pinned_codex_identity(self) -> None:
        helper = (ROOT / "scripts/run-app-server.sh").read_text(encoding="utf-8")
        for expected in (
            "CODEX_BIN must be owned by root",
            "CODEX_HOME must be owned by the runner user",
            "CODEX_HOME must not be accessible by group or other users",
            'actual_version=$($CODEX_BIN --version)',
            'exec "$CODEX_BIN" app-server --listen stdio://',
        ):
            self.assertIn(expected, helper)


if __name__ == "__main__":
    unittest.main()

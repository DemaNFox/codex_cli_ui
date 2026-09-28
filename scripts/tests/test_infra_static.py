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
            "Slice=codex-web-ui-workload.slice",
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
        self.assertIn("Slice=codex-web-ui-workload.slice", runner)
        self.assertIn("EnvironmentFile=/etc/codex-web-ui/codex-runner.env", runner)
        self.assertIn("InaccessiblePaths=-/etc/codex-web-ui/codex-web-ui.env", runner)
        self.assertIn("ReadOnlyPaths=-/var/lib/codex-web-ui/data/attachments", runner)
        self.assertIn("Accept=yes", socket)
        self.assertIn("SocketMode=0600", socket)

        workload_slice = (ROOT / "infra/systemd/codex-web-ui-workload.slice").read_text(
            encoding="utf-8"
        )
        broker_socket = (
            ROOT / "infra/systemd/codex-web-ui-resource-broker.socket"
        ).read_text(encoding="utf-8")
        broker_service = (
            ROOT / "infra/systemd/codex-web-ui-resource-broker@.service"
        ).read_text(encoding="utf-8")
        self.assertIn("MemorySwapMax=0", workload_slice)
        self.assertNotIn("MemoryMax=4G", unit + runner + workload_slice)
        self.assertIn("Accept=yes", broker_socket)
        self.assertIn("SocketUser=codex-web-ui-api", broker_socket)
        self.assertIn("SocketMode=0600", broker_socket)
        self.assertIn("User=root", broker_service)
        self.assertIn("Slice=system.slice", broker_service)
        self.assertIn("CapabilityBoundingSet=", broker_service)
        self.assertIn("ProtectSystem=strict", broker_service)
        self.assertIn("InaccessiblePaths=-/etc/codex-web-ui/codex-web-ui.env", broker_service)
        self.assertIn("RestrictAddressFamilies=AF_UNIX", broker_service)

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
        drain = (ROOT / "scripts/graceful-drain.sh").read_text(encoding="utf-8")
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
            "codex-web-ui-resource-broker.socket",
            "codex-web-ui-resource-broker@.service",
            "codex-web-ui-workload.slice",
            "codex-web-ui-resource-broker --initialize",
            "changing the runner user requires an explicit migration workflow",
            "managed_codex_bin=",
            "an explicit --codex-home must already exist",
            "exec {tty_fd}<>/dev/tty",
            "runner_config_backup=",
            "load_toolchain_pins",
            "trap rollback_activation EXIT",
            "systemctl restart codex-web-ui-resource-broker.socket codex-web-ui-app-server.socket codex-web-ui@api.service",
            'bash "$package/scripts/graceful-drain.sh" "${drain_args[@]}"',
            'bash "$package/scripts/graceful-drain.sh" --release',
            "trap clear_pre_activation_drain EXIT",
            "--check-releases --additional-releases 1",
        ):
            self.assertIn(expected, installer)
        self.assertNotIn("http://", installer)
        self.assertNotIn('source "$PACKAGE_ROOT/infra/toolchain.env"', installer)
        self.assertNotIn('source "$REPO_ROOT/infra/toolchain.env"', bootstrap)
        self.assertNotIn("--confirm-legacy-idle", wrapper)
        for expected in (
            "marker=/var/lib/codex-web-ui/data/upgrade-drain",
            "activeTurns",
            "pendingTurnStarts",
            'drain.get("acceptingNewTurns") is False',
            "installed API lacks drain telemetry",
            "fence external turn admission",
            "verify all app-server runners are inactive",
            "activation was not attempted",
        ):
            self.assertIn(expected, drain)
        for expected in (
            "NODE_LINUX_X64_SHA256",
            "PNPM_TARBALL_SHA512",
            "CODEX_LINUX_ARM64_TARBALL_SHA512",
            "https://nodejs.org/download/release/v${NODE_VERSION}",
            "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}.tgz",
            "sha256sum --check --strict --status",
            "sha512sum --check --strict --status",
            "/opt/codex-web-ui/runtime",
            "Preserving existing unmanaged /usr/local/bin/codex",
            'chmod 0755 "$toolchain_stage"',
        ):
            self.assertIn(expected, bootstrap)
        self.assertNotIn("curl |", bootstrap)
        self.assertNotIn("@latest", bootstrap)
        self.assertNotIn("@alpha", bootstrap)
        package_builder = (ROOT / "scripts/prepare-package.sh").read_text(encoding="utf-8")
        self.assertIn("package build mode requires Linux", package_builder)

    def test_upgrade_drain_precedes_every_activation_side_effect(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        updater = (ROOT / "scripts/update-ubuntu.sh").read_text(encoding="utf-8")
        begin = installer.index('bash "$package/scripts/graceful-drain.sh" "${drain_args[@]}"')
        copy = installer.index('copy_release "$package" "$release_dir"')
        switch = installer.index('atomic_symlink "$release_dir" /opt/codex-web-ui/current')
        runner_stop = installer.index("systemctl stop 'codex-web-ui-app-server@*.service'")
        release = installer.rindex('bash "$package/scripts/graceful-drain.sh" --release')
        post_switch_health = installer.index(
            '"$package/scripts/health-check.sh" --service-user api --timeout 45'
        )
        self.assertLess(begin, copy)
        self.assertLess(copy, switch)
        self.assertLess(begin, switch)
        self.assertLess(switch, runner_stop)
        self.assertLess(post_switch_health, release)
        self.assertIn('rm -f -- "$drain_marker"', installer)
        self.assertIn('rm -rf --one-file-system -- "$release_dir"', installer)

        update_begin = updater.index('bash "$SCRIPT_DIR/graceful-drain.sh" \\\n  --begin')
        update_copy = updater.index('copy_release "$source_dir" "$release_dir"')
        update_switch = updater.index('atomic_symlink "$release_dir" /opt/codex-web-ui/current')
        update_health = updater.index(
            'if ! "$SCRIPT_DIR/health-check.sh" --timeout "$health_timeout" --service-user "$service_user"'
        )
        update_release = updater.rindex('--release --config "$config"')
        self.assertLess(update_begin, update_copy)
        self.assertLess(update_copy, update_switch)
        self.assertLess(update_switch, update_health)
        self.assertLess(update_health, update_release)
        self.assertIn('--service-user "$service_user"', updater)
        self.assertIn('trap rollback_activation EXIT', updater)
        self.assertIn('Rollback release failed its health check; the drain remains engaged.', updater)
        self.assertNotIn('rm -f -- "$drain_marker"', updater)
        self.assertIn('Rollback is healthy but the drain could not be released.', updater)
        self.assertIn('[[ -f $drain_marker ]] && drain_engaged=true', updater)
        self.assertIn('if $drain_engaged; then', updater)

    def test_resource_boundary_install_and_rollback_are_transactional(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        updater = (ROOT / "scripts/update-ubuntu.sh").read_text(encoding="utf-8")
        common = (ROOT / "scripts/lib/ubuntu-common.sh").read_text(encoding="utf-8")

        managed_paths = (
            "/etc/systemd/system/codex-web-ui@.service",
            "/etc/systemd/system/codex-web-ui-app-server@.service",
            "/etc/systemd/system/codex-web-ui-resource-broker.socket",
            "/etc/systemd/system/codex-web-ui-resource-broker@.service",
            "/etc/systemd/system/codex-web-ui-workload.slice",
            "/usr/local/libexec/codex-web-ui-resource-broker",
            "/etc/codex-web-ui/resource-limits.json",
            "/etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf",
        )
        for script in (installer, updater):
            for path in managed_paths:
                self.assertIn(path, script)
            self.assertIn("snapshot_activation_file", script)
            self.assertIn("restore_activation_file", script)
            self.assertIn("broker_socket_was_active", script)
            self.assertIn("broker_socket_was_enabled", script)
            self.assertIn("workload_slice_was_active", script)
            self.assertIn("restore_resource_boundary", script)
            self.assertIn("Rollback could not restore the previous resource boundary exactly.", script)
            provisional_handler_start = script.index("cleanup_resource_snapshot()")
            snapshot_dir = script.index('resource_rollback_dir=$(mktemp -d')
            provisional_trap = script.index("trap cleanup_resource_snapshot EXIT", snapshot_dir)
            snapshot_call = script.index("snapshot_activation_file", provisional_trap)
            rollback_trap = script.index("trap rollback_activation EXIT", snapshot_call)
            self.assertLess(
                snapshot_dir,
                script.index('atomic_symlink "$release_dir" /opt/codex-web-ui/current'),
            )
            self.assertLess(provisional_handler_start, snapshot_dir)
            self.assertLess(snapshot_dir, provisional_trap)
            self.assertLess(provisional_trap, snapshot_call)
            self.assertLess(snapshot_call, rollback_trap)
            provisional_handler = script[
                provisional_handler_start:snapshot_dir
            ]
            self.assertIn('remove_activation_backup "$resource_rollback_dir"', provisional_handler)
            if script == installer:
                self.assertIn('case "$release_dir" in', provisional_handler)
                self.assertIn('/opt/codex-web-ui/releases/*)', provisional_handler)
                self.assertIn('rm -rf --one-file-system -- "$release_dir"', provisional_handler)
            rollback = script.index("if ! restore_resource_boundary; then")
            restart = script.index("systemctl restart", rollback)
            self.assertLess(rollback, restart)

        for unit in (
            "codex-web-ui@.service",
            "codex-web-ui-app-server@.service",
            "codex-web-ui-resource-broker.socket",
            "codex-web-ui-resource-broker@.service",
            "codex-web-ui-workload.slice",
        ):
            self.assertIn(unit, updater)
        helper_install = (
            'install -m 0755 "$release_dir/scripts/resource-broker.py" '
            "/usr/local/libexec/codex-web-ui-resource-broker"
        )
        self.assertIn(helper_install, updater)
        self.assertNotIn(
            "if [[ -x /usr/local/libexec/codex-web-ui-resource-broker ]]", updater
        )
        helper = updater.index(helper_install)
        reload = updater.index("systemctl daemon-reload", helper)
        slice_start = updater.index("systemctl start codex-web-ui-workload.slice", reload)
        socket_enable = updater.index(
            "systemctl enable codex-web-ui-resource-broker.socket", slice_start
        )
        socket_restart = updater.index(
            "systemctl restart codex-web-ui-resource-broker.socket", socket_enable
        )
        reconcile = updater.index(
            "/usr/local/libexec/codex-web-ui-resource-broker --initialize", socket_restart
        )
        api_restart = updater.index('systemctl restart "codex-web-ui@${service_user}.service"', reconcile)
        self.assertLess(helper, reload)
        self.assertLess(reload, slice_start)
        self.assertLess(slice_start, socket_enable)
        self.assertLess(socket_enable, socket_restart)
        self.assertLess(socket_restart, reconcile)
        self.assertLess(reconcile, api_restart)

        for expected in (
            "snapshot_activation_file()",
            "restore_activation_file()",
            "activation artifact is not a regular file",
            "stat -c '%a'",
            "stat -c '%u'",
            "stat -c '%g'",
            "/var/lib/codex-web-ui/.activation-rollback.*",
            "rm -rf --one-file-system",
        ):
            self.assertIn(expected, common)

    def test_drain_health_contract_is_fail_closed(self) -> None:
        drain = (ROOT / "scripts/graceful-drain.sh").read_text(encoding="utf-8")
        requested_checks = (
            'drain.get("requested") is True',
            'drain.get("acceptingNewTurns") is False',
            'drain.get("idle") is True',
            "active == 0",
            "pending == 0",
        )
        released_checks = (
            'drain.get("requested") is False',
            'drain.get("acceptingNewTurns") is True',
            'drain.get("idle") is False',
        )
        for expected in requested_checks + released_checks:
            self.assertIn(expected, drain)
        self.assertIn('if "upgradeDrain" not in value:', drain)
        self.assertNotIn("legacy_idle_confirmed", drain)
        self.assertNotIn("systemctl stop codex-web-ui@api.service", drain)
        self.assertIn("fence external turn admission", drain)

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

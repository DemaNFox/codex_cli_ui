from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class InfraStaticTest(unittest.TestCase):
    def test_codex_update_boundary_is_packaged_and_installed_as_fixed_helpers(self) -> None:
        release = (ROOT / "scripts/prepare-release.sh").read_text(encoding="utf-8")
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        worker = (ROOT / "scripts/codex-update-worker.sh").read_text(encoding="utf-8")
        for artifact in (
            "codex-web-ui-codex-update-broker.socket",
            "codex-web-ui-codex-update-broker@.service",
            "codex-web-ui-codex-update.service",
            "scripts/codex-update-broker.py",
            "scripts/codex-update-worker.sh",
            "scripts/stage-codex-update.sh",
        ):
            self.assertIn(artifact, release)
            self.assertIn(artifact.split("/")[-1], installer)
        self.assertIn("/usr/local/libexec/codex-web-ui-codex-update-broker", installer)
        self.assertIn("/usr/local/libexec/codex-web-ui-codex-update-worker", installer)
        self.assertIn("/usr/local/sbin/codex-web-ui-stage-codex-update", installer)
        self.assertIn("config_backup=", installer)
        self.assertIn('CODEX_WEB_CODEX_VERSION_PIN=', installer)
        self.assertIn(
            "/lib/node_modules/@openai/codex/bin/codex.js) codex_bin=$managed_codex_bin",
            installer,
        )
        self.assertIn('install -m 0600 -o root -g root "$config_backup" "$config"', installer)
        self.assertIn("app-server generate-json-schema", installer)
        self.assertIn("candidate Codex protocol differs from reviewed snapshot", installer)
        self.assertLess(
            installer.index("app-server generate-json-schema"),
            installer.index('bash "$package/scripts/graceful-drain.sh" "${drain_args[@]}"'),
        )
        self.assertIn('exec bash "$relocated" --relocated', worker)
        self.assertIn('--package "$candidate"', worker)
        self.assertIn("--upgrade", worker)
        self.assertNotIn("curl", worker)
        stage = (ROOT / "scripts/stage-codex-update.sh").read_text(encoding="utf-8")
        broker = (ROOT / "scripts/codex-update-broker.py").read_text(encoding="utf-8")
        self.assertIn("codex-update-candidate.lock", stage)
        self.assertIn("codex-update.lock", stage)
        self.assertIn("codex-update-candidate.lock", worker)
        self.assertIn("codex-update-candidate.lock", broker)
        for expected in (
            "--source",
            "--release-id",
            '"$verifier" --verify "$source_dir" --arch "$target_arch"',
            "--check-releases",
            "--additional-releases 1",
            'install -d -m 0700 -o root -g root "$stage"',
            'cp -a --no-preserve=ownership -- "$source_dir/." "$stage/"',
            'chown -R root:root "$stage"',
            'chmod -R go-w "$stage"',
            'mv -- "$stage" "$target"',
            '"$verifier" --verify "$stage" --arch "$target_arch"',
        ):
            self.assertIn(expected, stage)
        self.assertNotIn("curl", stage)
        source_verify = stage.index('"$verifier" --verify "$source_dir" --arch "$target_arch"')
        capacity = stage.index("--additional-releases 1", source_verify)
        copy = stage.index('cp -a --no-preserve=ownership -- "$source_dir/." "$stage/"')
        copied_verify = stage.index('"$verifier" --verify "$stage" --arch "$target_arch"')
        activate = stage.index('mv -- "$stage" "$target"')
        link = stage.index('mv -Tf -- "$link_temporary" "$candidate_link"', activate)
        self.assertLess(source_verify, capacity)
        self.assertLess(capacity, copy)
        self.assertLess(copy, copied_verify)
        self.assertLess(copied_verify, activate)
        self.assertLess(activate, link)

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

        host_admin = (
            ROOT / "infra/systemd/codex-web-ui-app-server-host-admin@.service"
        ).read_text(encoding="utf-8")
        self.assertIn("User=root", host_admin)
        self.assertIn("Group=root", host_admin)
        self.assertIn("Slice=codex-web-ui-workload.slice", host_admin)
        self.assertIn("Nice=5", host_admin)
        for forbidden in (
            "NoNewPrivileges=",
            "CapabilityBoundingSet=",
            "ProtectSystem=",
            "ProtectHome=",
            "PrivateDevices=",
            "InaccessiblePaths=",
            "ReadOnlyPaths=",
            "ReadWritePaths=",
        ):
            self.assertNotIn(forbidden, host_admin)

        workload_slice = (ROOT / "infra/systemd/codex-web-ui-workload.slice").read_text(
            encoding="utf-8"
        )
        broker_socket = (
            ROOT / "infra/systemd/codex-web-ui-resource-broker.socket"
        ).read_text(encoding="utf-8")
        broker_service = (
            ROOT / "infra/systemd/codex-web-ui-resource-broker@.service"
        ).read_text(encoding="utf-8")
        update_broker_socket = (
            ROOT / "infra/systemd/codex-web-ui-codex-update-broker.socket"
        ).read_text(encoding="utf-8")
        update_broker_service = (
            ROOT / "infra/systemd/codex-web-ui-codex-update-broker@.service"
        ).read_text(encoding="utf-8")
        update_worker = (
            ROOT / "infra/systemd/codex-web-ui-codex-update.service"
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
        self.assertIn("SocketUser=codex-web-ui-api", update_broker_socket)
        self.assertIn("SocketMode=0600", update_broker_socket)
        self.assertIn("User=root", update_broker_service)
        self.assertIn("CapabilityBoundingSet=", update_broker_service)
        self.assertIn("ProtectSystem=strict", update_broker_service)
        self.assertIn("ReadWritePaths=/run/codex-web-ui", update_broker_service)
        self.assertIn("RestrictAddressFamilies=AF_UNIX", update_broker_service)
        self.assertIn("ExecStart=/usr/local/libexec/codex-web-ui-codex-update-worker", update_worker)
        self.assertIn("User=root", update_worker)
        self.assertNotIn("/bin/sh -c", update_broker_service + update_worker)

        guard_unit = (ROOT / "infra/systemd/codex-web-ui-storage-guard@.service").read_text(
            encoding="utf-8"
        )
        timer = (ROOT / "infra/systemd/codex-web-ui-storage-guard@.timer").read_text(
            encoding="utf-8"
        )
        self.assertIn("User=root", guard_unit)
        self.assertIn("codex-web-ui-storage-enforce %i", guard_unit)
        self.assertIn("OnUnitActiveSec=1min", timer)

    def test_installer_supports_explicit_runner_modes_and_transactional_migration(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        migration = (ROOT / "scripts/migrate-runner-host-admin.sh").read_text(
            encoding="utf-8"
        )
        common = (ROOT / "scripts/lib/ubuntu-common.sh").read_text(encoding="utf-8")
        required = (ROOT / "scripts/prepare-package.sh").read_text(encoding="utf-8")

        for expected in (
            "--runner-mode",
            "restricted|host-admin",
            "CODEX_WEB_RUNNER_MODE",
            "changing the runner mode requires an explicit migration workflow",
            "codex-web-ui-app-server-host-admin@.service",
            "--migrate-runner-mode",
            "Host-admin runner migration is already complete",
            "--migrate-runner-mode cannot be combined with --no-start",
            'bash "$SCRIPT_DIR/migrate-runner-host-admin.sh"',
            'python3 "$package/scripts/install-local-host-instructions.py"',
            'python3 "$package/scripts/rebase-codex-home.py"',
        ):
            self.assertIn(expected, installer)
        self.assertLess(
            installer.index('bash "$SCRIPT_DIR/migrate-runner-host-admin.sh"'),
            installer.index(
                'if [[ $mode == upgrade && $legacy_single_service == false ]]; then',
                installer.index("runner_config="),
            ),
        )
        repair = installer.index('python3 "$package/scripts/rebase-codex-home.py"')
        start_branch = installer.index(
            "if $start_service; then", installer.index('CODEX_WEB_CONFIG="$config"')
        )
        self.assertLess(
            installer.rindex("systemctl stop codex-web-ui-app-server.socket", 0, repair),
            repair,
        )
        self.assertLess(
            installer.index("app-server socket remained active before Codex state repair"),
            repair,
        )
        self.assertLess(repair, start_branch)
        self.assertIn(
            "rebase_args+=(--source-home /var/lib/codex-web-ui/codex-home)",
            installer,
        )
        self.assertIn(
            "rebase_args+=(--source-home /opt/ai-chat-agents/home/.codex)",
            installer,
        )
        self.assertLess(
            installer.index(
                "installed runner configuration is missing or unsafe",
                installer.index("if [[ -n $migrate_runner_mode ]]")
            ),
            installer.index(
                "installed_runner_mode=$(sed",
                installer.index("if [[ -n $migrate_runner_mode ]]")
            ),
        )
        for expected in (
            'graceful-drain.sh" --begin',
            "systemctl stop codex-web-ui-app-server.socket codex-web-ui@api.service",
            'cp -a --no-preserve=ownership -- "$source_codex_home/." "$stage/"',
            "copied Codex profile inventory differs from the source",
            "contains a symlink and cannot cross the privilege boundary",
            "target CODEX_HOME already exists; profiles are never merged",
            "target CODEX_HOME parent must be owned by root",
            "target CODEX_HOME parent must not be writable by group or other users",
            'mv -T -- "$stage" "$target_codex_home"',
            "migrated CODEX_HOME did not activate at the expected path",
            "login status",
            "restore_activation_file",
            'chown -hR root:root "$source_codex_home"',
            'chmod 0700 "$source_codex_home"',
            "migration committed independently of the package upgrade",
            'python3 "$SCRIPT_DIR/install-local-host-instructions.py"',
            'python3 "$SCRIPT_DIR/rebase-codex-home.py"',
        ):
            self.assertIn(expected, migration)
        self.assertLess(
            migration.index('graceful-drain.sh" --begin'),
            migration.index('cp -a --no-preserve=ownership'),
        )
        self.assertLess(
            migration.index('python3 "$SCRIPT_DIR/install-local-host-instructions.py"'),
            migration.index("SOURCE_HOME=$source_codex_home SOURCE_UID=$source_uid"),
        )
        rename = migration.index('mv -T -- "$stage" "$target_codex_home"')
        self.assertLess(migration.rindex("trap '' INT TERM", 0, rename), rename)
        self.assertLess(rename, migration.index("target_created=true", rename))
        self.assertLess(
            migration.index("target_created=true", rename),
            migration.index("trap 'exit 130' INT", rename),
        )
        self.assertLess(
            migration.index('"$SCRIPT_DIR/health-check.sh"'),
            migration.index('chown -hR root:root "$source_codex_home"'),
        )
        self.assertIn("validate_runner_user()", common)
        self.assertIn("$mode == host-admin && $path == /", common)
        self.assertIn('"scripts/migrate-runner-host-admin.sh"', required)
        self.assertIn(
            '"infra/systemd/codex-web-ui-app-server-host-admin@.service"', required
        )
        wrapper = (ROOT / "install.sh").read_text(encoding="utf-8")
        self.assertIn(
            "--runner-mode|--migrate-runner-mode|--migration-codex-home|--runner-user",
            wrapper,
        )

    def test_installer_preserves_only_the_exact_legacy_bare_ip_before_migration(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        validation_start = installer.index(
            "PUBLIC_ORIGIN=$public_origin ALLOW_EXISTING_BARE_IP=$allow_existing_bare_ip python3"
        )
        validation_body_start = installer.index("\n", validation_start) + 1
        validation_end = installer.index("\nPY\n", validation_body_start)
        validation = installer[validation_body_start:validation_end]
        migration = installer.index('bash "$SCRIPT_DIR/migrate-runner-host-admin.sh"')

        self.assertIn('[[ $public_origin == "$installed_origin" ]]', installer)
        self.assertIn("if [[ $mode == upgrade ]]; then allow_existing_bare_ip=true; fi", installer)
        self.assertLess(validation_start, migration)

        def validate(origin: str, allow_existing_bare_ip: bool) -> subprocess.CompletedProcess[str]:
            environment = os.environ.copy()
            environment["PUBLIC_ORIGIN"] = origin
            environment["ALLOW_EXISTING_BARE_IP"] = (
                "true" if allow_existing_bare_ip else "false"
            )
            return subprocess.run(
                [sys.executable, "-c", validation],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(validate("https://codex.example.test", False).returncode, 0)
        fresh_ip = validate("https://192.0.2.10", False)
        self.assertNotEqual(fresh_ip.returncode, 0)
        self.assertIn("must use a DNS name", fresh_ip.stderr)
        self.assertEqual(validate("https://192.0.2.10", True).returncode, 0)

    def test_legacy_single_service_adoption_rewrites_only_runtime_boundary(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        command = installer.index(
            "PROJECT_ROOTS=$roots_csv LEGACY_ADOPTION=$legacy_single_service RUNNER_MODE=$runner_mode python3"
        )
        body_start = installer.index("\n", command) + 1
        body_end = installer.index("\nPY\n", body_start)
        transformer = installer[body_start:body_end]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "legacy.env"
            destination = Path(directory) / "split.env"
            source.write_text(
                "\n".join(
                    (
                        "CODEX_WEB_PUBLIC_ORIGIN=https://192.0.2.10",
                        "CODEX_WEB_PROJECT_ROOTS=/srv/codex-projects",
                        'CODEX_WEB_CODEX_VERSION_PIN="codex-cli 0.153.4"',
                        "CODEX_WEB_ADMIN_USERNAME=owner",
                        "CODEX_WEB_ADMIN_PASSWORD_HASH=preserve-me",
                        "CODEX_WEB_SESSION_SECRET=preserve-me-too",
                        "CODEX_BIN=/opt/codex-web-ui/old/bin/codex",
                        "CODEX_HOME=/var/lib/codex-web-ui/codex-home",
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "CONFIG_SOURCE": str(source),
                    "CONFIG_DESTINATION": str(destination),
                    "VERSION_PIN": "codex-cli 0.153.4",
                    "PROJECT_ROOTS": "/srv/codex-projects",
                    "LEGACY_ADOPTION": "true",
                    "RUNNER_MODE": "restricted",
                }
            )
            result = subprocess.run(
                [sys.executable, "-c", transformer],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            migrated = destination.read_text(encoding="utf-8")
            self.assertNotIn("CODEX_BIN=", migrated)
            self.assertNotIn("CODEX_HOME=", migrated)
            self.assertIn(
                "CODEX_WEB_APP_SERVER_SOCKET=/run/codex-web-ui/app-server.sock", migrated
            )
            self.assertIn(
                "CODEX_WEB_CODEX_UPDATE_BROKER_SOCKET=/run/codex-web-ui/codex-update-broker.sock",
                migrated,
            )
            self.assertIn("CODEX_WEB_ADMIN_PASSWORD_HASH=preserve-me", migrated)
            self.assertIn("CODEX_WEB_SESSION_SECRET=preserve-me-too", migrated)

            environment.update(
                {
                    "CONFIG_SOURCE": str(destination),
                    "CONFIG_DESTINATION": str(source),
                    "PROJECT_ROOTS": "/",
                    "LEGACY_ADOPTION": "false",
                    "RUNNER_MODE": "host-admin",
                }
            )
            result = subprocess.run(
                [sys.executable, "-c", transformer],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("CODEX_WEB_PROJECT_ROOTS=/\n", source.read_text(encoding="utf-8"))
            self.assertIn(
                "CODEX_WEB_PROJECT_PATH_BROKER_SOCKET=/run/codex-web-ui/project-path-broker.sock",
                source.read_text(encoding="utf-8"),
            )

    def test_candidate_protocol_accepts_untracked_split_schema_files(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        marker = "import hashlib\nimport json\nimport os\nfrom pathlib import Path"
        body_start = installer.index(marker, installer.index("PROTOCOL_STAGE=$protocol_stage"))
        body_end = installer.index("\nPY\nthen", body_start)
        validator = installer[body_start:body_end]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            generated = root / "generated"
            (package / "protocol").mkdir(parents=True)
            generated.mkdir()
            expected = b"reviewed combined schema"
            (generated / "combined.json").write_bytes(expected)
            (generated / "split-extra.json").write_bytes(b"untracked per-type schema")
            (package / "protocol" / "manifest.json").write_text(
                json.dumps(
                    {
                        "files": {
                            "0.153.4/combined.json": hashlib.sha256(expected).hexdigest()
                        }
                    }
                ),
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment.update(
                {"PROTOCOL_STAGE": str(generated), "PACKAGE_ROOT": str(package)}
            )
            result = subprocess.run(
                [sys.executable, "-c", validator],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_legacy_adoption_uses_old_identity_for_drain_and_rollback(self) -> None:
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        rollback_trap = installer.index("trap rollback_activation EXIT")
        ownership_change = installer.index(
            "chown -R codex-web-ui-api:codex-web-ui /var/lib/codex-web-ui/data",
            rollback_trap,
        )
        health = installer.index(
            '"$package/scripts/health-check.sh" --service-user api --timeout 45',
            ownership_change,
        )
        legacy_disable = installer.index(
            'systemctl disable "codex-web-ui@${legacy_service_user}.service"', health
        )

        self.assertLess(rollback_trap, ownership_change)
        self.assertLess(health, legacy_disable)
        self.assertIn('drain_service_user=$legacy_service_user', installer)
        self.assertIn('rollback_service_user=$legacy_service_user', installer)
        self.assertIn(
            'systemctl start "codex-web-ui-storage-guard@${legacy_service_user}.timer"',
            installer,
        )
        self.assertIn("legacy storage guard did not quiesce before topology adoption", installer)
        self.assertIn("legacy service instances remained enabled after split activation", installer)
        self.assertIn("legacy_state_restored=false", installer)
        self.assertIn('$legacy_state_restored || rollback_healthy=false', installer)
        self.assertIn('/opt/codex-web-ui/codex-runtime/bin/codex', installer)
        self.assertIn(
            'chown -R "$legacy_service_user:$legacy_service_group" /var/lib/codex-web-ui/data',
            installer,
        )
        self.assertIn(
            "legacy single-service installations must complete one ordinary --upgrade",
            installer,
        )
        self.assertIn(
            "legacy single-service adoption cannot be combined with --no-start", installer
        )
        self.assertIn(
            '[[ $migrate_runner_mode == host-admin && $roots_csv == / ]]', installer
        )
        self.assertIn(
            '[[ $root =~ ^/[A-Za-z0-9_./@+-]*$ ]]', installer
        )
        self.assertIn(
            "changing project roots requires an explicit host-admin migration to /", installer
        )

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
            'microphone=(self)',
            "img-src 'self' data: blob:;",
            "X-Content-Type-Options",
            "root /opt/codex-web-ui/web-current;",
            "try_files $uri $uri/ /index.html;",
        ):
            self.assertIn(expected, nginx)
        self.assertEqual(nginx.count("proxy_pass http://codex_web_backend;"), 3)
        static_route = nginx.split("location / {", 1)[1].split("}", 1)[0]
        self.assertIn("root /opt/codex-web-ui/web-current;", static_route)
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
            "OPENAI_API_KEY",
            "CODEX_WEB_VAPID_PUBLIC_KEY",
            "CODEX_WEB_VAPID_PRIVATE_KEY",
            "CODEX_WEB_VAPID_SUBJECT",
        ):
            self.assertIn(f"{name}=\n", environment)
        self.assertIn('CODEX_WEB_CODEX_VERSION_PIN="codex-cli 0.159.3"', environment)
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
            "setup-push.mjs",
            "--external-proxy",
            "codex-web-ui-app-server.socket",
            "codex-web-ui-resource-broker.socket",
            "codex-web-ui-resource-broker@.service",
            "codex-web-ui-project-path-broker.socket",
            "codex-web-ui-project-path-broker@.service",
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
            "marker=/run/codex-web-ui/upgrade-drain",
            "legacy_marker=/var/lib/codex-web-ui/data/upgrade-drain",
            "os.O_EXCL | os.O_NOFOLLOW",
            "mktemp /tmp/codex-web-ui-upgrade-drain-health",
            'systemctl stop "codex-web-ui@${service_user}.service"',
            "legacy-upgrade-api-stopped",
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
        runner_stop = installer.index("systemctl stop codex-web-ui-app-server.socket", switch)
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

        portable_managed_paths = (
            "/etc/systemd/system/codex-web-ui@.service",
            "/etc/systemd/system/codex-web-ui-app-server@.service",
            "/etc/systemd/system/codex-web-ui-resource-broker.socket",
            "/etc/systemd/system/codex-web-ui-resource-broker@.service",
            "/etc/systemd/system/codex-web-ui-workload.slice",
            "/usr/local/libexec/codex-web-ui-resource-broker",
            "/etc/systemd/system/codex-web-ui-project-path-broker.socket",
            "/etc/systemd/system/codex-web-ui-project-path-broker@.service",
            "/usr/local/libexec/codex-web-ui-project-path-broker",
            "/etc/codex-web-ui/project-roots",
            "/etc/systemd/system/codex-web-ui-project-path-broker@.service.d/paths.conf",
            "/etc/codex-web-ui/resource-limits.json",
            "/etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf",
        )
        legacy_managed_paths = (
            "/etc/systemd/system/codex-web-ui-resource-broker.socket",
            "/etc/systemd/system/codex-web-ui-resource-broker@.service",
            "/etc/systemd/system/codex-web-ui-workload.slice",
            "/usr/local/libexec/codex-web-ui-resource-broker",
            "/etc/codex-web-ui/resource-limits.json",
            "/etc/systemd/system/codex-web-ui-workload.slice.d/50-resource-limits.conf",
        )
        for script, managed_paths in (
            (installer, portable_managed_paths),
            (updater, legacy_managed_paths),
        ):
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
            "codex-web-ui-resource-broker.socket",
            "codex-web-ui-resource-broker@.service",
            "codex-web-ui-workload.slice",
        ):
            self.assertIn(unit, updater)
        resource_units = updater[
            updater.index("resource_units=(") : updater.index(")", updater.index("resource_units=("))
        ]
        self.assertNotIn("codex-web-ui@.service", resource_units)
        self.assertNotIn("codex-web-ui-app-server@.service", resource_units)
        self.assertIn('SocketUser=$service_user', updater)
        self.assertIn('--serve-fd 0 --api-user $service_user', updater)
        self.assertIn('Slice=codex-web-ui-workload.slice', updater)
        self.assertIn('legacy_resource_drop_in_dir_was_present=false', updater)
        self.assertIn('[[ -e $legacy_resource_drop_in_dir || -L $legacy_resource_drop_in_dir ]]', updater)
        self.assertIn('rmdir -- "$legacy_resource_drop_in_dir"', updater)
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
        api_restart = updater.index(
            'systemctl restart "codex-web-ui@${service_user}.service"', socket_restart
        )
        self.assertLess(helper, reload)
        self.assertLess(reload, slice_start)
        self.assertLess(slice_start, socket_enable)
        self.assertLess(socket_enable, socket_restart)
        self.assertLess(socket_restart, api_restart)
        self.assertLess(api_restart, reconcile)

        portable_restart = installer.index(
            "systemctl restart codex-web-ui-resource-broker.socket "
            "codex-web-ui-app-server.socket codex-web-ui@api.service"
        )
        portable_reconcile = installer.index(
            "/usr/local/libexec/codex-web-ui-resource-broker --initialize", portable_restart
        )
        portable_health = installer.index('"$package/scripts/health-check.sh"', portable_reconcile)
        self.assertLess(portable_restart, portable_reconcile)
        self.assertLess(portable_reconcile, portable_health)

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
        self.assertIn("/opt/codex-web-ui/web-current", install_script)
        self.assertIn('chown root:root "$config"', install_script)
        self.assertIn('chmod 0600 "$config"', install_script)
        self.assertIn('/usr/local/libexec', install_script)
        self.assertNotIn('chown root:"$service_group" "$config"', install_script)
        self.assertIn("--check-releases --additional-releases 1", install_script)
        self.assertIn("--check-releases --additional-releases 1", update_script)
        self.assertIn("previous-release", update_script)
        self.assertIn("previous-web-release", update_script)
        self.assertIn("/opt/codex-web-ui/web-current", update_script)
        self.assertIn("[[ -L /opt/codex-web-ui/web-current ]]", update_script)
        self.assertIn("CPUQuota=\nMemoryHigh=infinity", update_script)
        self.assertIn("MemoryMax=infinity", update_script)
        self.assertIn("TasksMax=infinity", update_script)
        self.assertIn("restoring", update_script)
        self.assertIn("/opt/codex-web-ui/releases/*", rollback_script)
        self.assertIn("/opt/codex-web-ui/web-current", rollback_script)
        self.assertNotIn("rm -rf", install_script + update_script + rollback_script)
        self.assertIn('@codex-web/server', release_script)
        self.assertIn('--config.inject-workspace-packages=true deploy --prod', release_script)
        for dependency in (
            "'@codex-web/contracts'",
            "'@fastify/cookie'",
            "'argon2'",
            "'fastify'",
            "'web-push'",
            "'zod'",
        ):
            self.assertIn(dependency, release_script)
        self.assertNotIn('deploy --prod --legacy', release_script)
        for runtime_asset in (
            "codex-web-ui-resource-broker.socket",
            "codex-web-ui-resource-broker@.service",
            "codex-web-ui-workload.slice",
            "scripts/resource-broker.py",
        ):
            self.assertIn(runtime_asset, release_script)
        self.assertIn('SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"', health_script)

    def test_web_only_update_is_atomic_compatible_and_never_restarts_codex(self) -> None:
        updater = (ROOT / "scripts/update-web-ubuntu.sh").read_text(encoding="utf-8")
        rollback = (ROOT / "scripts/rollback-web-ubuntu.sh").read_text(encoding="utf-8")
        installer = (ROOT / "scripts/install-package.sh").read_text(encoding="utf-8")
        manifest = (ROOT / "infra/release-manifest.schema.json").read_text(encoding="utf-8")

        for expected in (
            '"apiCompatibility"',
            'web/API compatibility mismatch',
            'prepare-package.sh" --verify',
            '--check-releases --additional-releases 1',
            'copy_release "$source_dir" "$release_dir"',
            'atomic_symlink "$release_dir/apps/web/dist" /opt/codex-web-ui/web-current',
            "web-only update changed the backend release",
            "previous-web-release",
        ):
            self.assertIn(expected, updater if expected != '"apiCompatibility"' else manifest)
        self.assertNotIn("graceful-drain", updater)
        self.assertNotIn("systemctl", updater)
        self.assertIn("Backend was not restarted", rollback)
        self.assertNotIn("systemctl", rollback)
        self.assertIn("[[ -L /opt/codex-web-ui/web-current ]]", updater)
        self.assertIn("/opt/codex-web-ui/web-current", installer)

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

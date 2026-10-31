#!/usr/bin/env python3
"""Extracted-package loopback smoke: static UI, real auth and durable subscription state.

Synthetic local state only. Does not launch a browser, agent, core, or live node.
"""
import argparse
import contextlib
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

from package_artifacts import canonical, verify_archive


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise RuntimeError("Package smoke refuses HTTP redirects")


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.csrf = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                               urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, data=None, expected=200):
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise RuntimeError("Package smoke permits only same-origin relative paths")
        headers = {"Origin": self.origin}
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            response = self.http.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status != expected:
                raise RuntimeError(f"Package HTTP response {response.status}; expected {expected}")
            return response.read(), response.headers

    def json(self, path, data=None, expected=200):
        body, _ = self.request(path, data, expected)
        return json.loads(body)

    def login(self, username, password):
        self.csrf = self.json("/api/auth/login", {"username": username, "password": password})["csrfToken"]
        if not self.csrf:
            raise RuntimeError("Login did not return CSRF protection")


def clean_environment(workspace):
    # Never borrow operator bootstrap/authentication state from the invoking shell.
    return {**{key: value for key, value in os.environ.items() if not key.startswith("ROUTEWEAVER_")}, "TMPDIR": str(workspace)}


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError("Packaged server did not shut down cleanly")
    if process.returncode != 0:
        raise RuntimeError("Packaged server exited unsuccessfully")


@contextlib.contextmanager
def server(executable, workspace, arguments, environment):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    client = Client(f"http://127.0.0.1:{port}")
    # Logs may contain test session information; keep them private and transient.
    with (workspace / "process.log").open("w") as log:
        process = subprocess.Popen([str(executable), "--listen", f"127.0.0.1:{port}", *arguments],
                                   cwd=executable.parent, stdout=log, stderr=log, env=environment)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Packaged server exited before becoming ready")
                try:
                    client.request("/healthz")
                    break
                except (OSError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError("Packaged application did not become ready")
            yield client
        finally:
            stop_process(process)


def create_subscription(client):
    source = client.json("/api/me/sources", {"id": "smoke-source", "name": "Package source", "kind": "text",
                         "content": "socks5://proxy.example.com:1080#PackageEndpoint", "enabled": True})
    endpoints = source["snapshot"]["endpoints"]
    if len(endpoints) != 1:
        raise RuntimeError("Package import did not create exactly one endpoint")
    client.json("/api/me/collections", {"id": "smoke-collection", "name": "Package collection",
                "sources": [{"sourceId": "smoke-source", "steps": []}], "steps": []})
    target = {"adapterId": "mihomo", "version": "1.19.32"}
    client.json("/api/me/profiles", {"id": "smoke-profile", "name": "Persistent package profile", "target": target,
                "mode": "full", "collectionId": "smoke-collection", "ir": {"schemaVersion": "1.0", "id": "smoke-profile",
                "name": "Persistent package profile", "ownerId": "", "revision": "1", "endpoints": [],
                "groups": [{"id": "selected", "name": "Selected", "kind": "manual", "members": [{"kind": "endpoint", "ref": endpoints[0]["id"]}]}],
                "rules": [], "resources": [], "defaultAction": {"kind": "group", "ref": "selected"}, "runtime": {"mixedPort": 7890}}})
    output = client.json("/api/me/outputs", {"id": "smoke-output", "name": "Persistent package feed", "profileId": "smoke-profile",
                         "target": target, "mode": "full"}, expected=201)
    body, _ = Client(client.origin).request(output["feedPath"])
    if b"PackageEndpoint" not in body or b"<!doctype html>" in body.lower():
        raise RuntimeError("Anonymous subscription did not contain the imported endpoint")
    return output["feedPath"], body


def smoke(archive_path):
    provenance = verify_archive(archive_path)
    with tempfile.TemporaryDirectory(prefix="routeweaver-package-smoke-") as temporary:
        workspace = Path(temporary)
        with tarfile.open(archive_path) as archive:
            archive.extractall(workspace, filter="data")
        applications = list(workspace.glob("*/routeweaver-control-plane"))
        if len(applications) != 1:
            raise RuntimeError("Package must contain exactly one control plane")
        executable = applications[0]
        manifest = json.loads((executable.parent / "SOURCE-MANIFEST.json").read_text())
        if hashlib.sha256(canonical(manifest["files"])).hexdigest() != provenance["source"]["sha256"]:
            raise RuntimeError("Embedded source manifest differs from package provenance")
        environment = clean_environment(workspace)
        with server(executable, workspace, ["--demo"], environment) as client:
            page, _ = client.request("/")
            scripts = re.findall(r'src="([^"]+\.js)"', page.decode())
            if not scripts:
                raise RuntimeError("Packaged shell has no JavaScript entry")
            for path in scripts:
                if not path.startswith("/assets/"):
                    raise RuntimeError("Unexpected external application script")
                _, headers = client.request(path)
                if "javascript" not in headers.get("Content-Type", ""):
                    raise RuntimeError("Packaged JavaScript has an incorrect content type")
            client.login("routeweaver", "local-demo-password")
        # Missing key must fail before opening a persistent database.
        database = workspace / "persistent.db"
        rejected = subprocess.run([str(executable), "--db", str(database)], cwd=executable.parent, env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if rejected.returncode == 0 or b"ROUTEWEAVER_MASTER_KEY" not in rejected.stderr or database.exists():
            raise RuntimeError("Missing-key startup did not fail closed before opening state")
        username, password = "package-smoke", secrets.token_urlsafe(32)
        persistent = {**environment, "ROUTEWEAVER_MASTER_KEY": secrets.token_hex(32)}
        bootstrap = {**persistent, "ROUTEWEAVER_ADMIN_USERNAME": username, "ROUTEWEAVER_ADMIN_PASSWORD": password}
        with server(executable, workspace, ["--db", str(database)], bootstrap) as client:
            client.login(username, password)
            # Genuine fresh-store evidence, before any fixture writes. The
            # browser's controlled-empty inventories do not prove startup state.
            for path in ("/api/hosts", "/api/server-deployments", "/api/me/collections"):
                inventory = client.json(path)
                if not isinstance(inventory, list) or inventory:
                    raise RuntimeError(f"Fresh non-demo inventory is not an empty list: {path}")
            feed_path, original = create_subscription(client)
        if not database.is_file():
            raise RuntimeError("Persistent package did not create a database")
        # Same key/database, no bootstrap credentials: real restart, not a demo reset.
        with server(executable, workspace, ["--db", str(database)], persistent) as client:
            anonymous = Client(client.origin)
            if anonymous.request(feed_path)[0] != original:
                raise RuntimeError("Published subscription did not survive process restart")
            client.login(username, password)
            access = client.json("/api/me/outputs/smoke-output/access")
            if access["feedPath"] != feed_path:
                raise RuntimeError("Persisted subscription access changed on restart")
            rotated = client.json("/api/me/outputs/smoke-output/rotate", {})["feedPath"]
            if rotated == feed_path or anonymous.request(rotated)[0] != original:
                raise RuntimeError("Rotated subscription did not retain its published content")
            anonymous.request(feed_path, expected=404)
        if list(workspace.glob("routeweaver-demo-*")):
            raise RuntimeError("Demo did not remove its disposable state on shutdown")
    receipt = {"schemaVersion": 1, "result": "passed", "archive": provenance["archive"], "source": provenance["source"],
               "checks": ["demo-static-ui-and-auth", "missing-key-startup-rejected", "fresh-non-demo-inventories-empty",
                          "non-demo-source-profile-publication",
                          "anonymous-subscription", "persistent-restart-without-bootstrap", "rotation-and-old-link-denial", "clean-shutdown"],
               "limitations": "No Chromium, real client, native process, node deployment, TLS proxy, or production acceptance."}
    Path(str(archive_path) + ".smoke.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print("PASS: extracted package static/auth, fresh non-demo empty inventories, persistence, anonymous subscription, rotation and old-link denial. Not browser or deployment acceptance.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?", default=Path("bin/packages/routeweaver-linux-amd64.tar.gz"))
    args = parser.parse_args()
    # Remove stale successful receipt before any validation or execution.
    Path(str(args.archive) + ".smoke.json").unlink(missing_ok=True)
    smoke(args.archive.resolve())


if __name__ == "__main__":
    main()

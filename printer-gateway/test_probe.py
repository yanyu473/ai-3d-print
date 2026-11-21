"""HTTP contract tests using loopback fixtures only."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

from probe import API_KEY_ENV, MOONRAKER_QUERY, endpoint_url, probe


@contextmanager
def fixture(routes):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.command, self.path, dict(self.headers)))
            code, headers, data = routes.get(self.path, (404, {}, {}))
            body = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        worker.start()
        try:
            yield "http://127.0.0.1:{}".format(server.server_address[1]), requests
        finally:
            server.shutdown()
            worker.join()


def ok(response):
    return 200, {}, response


class ProbeTests(unittest.TestCase):
    def test_octoprint_records_temperature_and_native_percent(self):
        token = "fixture-secret"
        routes = {
            "/octo/api/version": ok({"text": "OctoPrint 2.0.0", "server": "2.0.0"}),
            "/octo/api/printer": ok({
                "state": {"text": "Printing", "flags": {"printing": True}},
                "temperature": {"tool0": {"actual": 212.5, "target": 215}},
            }),
            "/octo/api/job": ok({
                "state": "Printing",
                "job": {"file": {"path": "private-part.gcode"}, "user": token},
                "progress": {"completion": 43.5, "printTime": 18, "printTimeLeft": 21},
            }),
        }
        with fixture(routes) as (url, requests):
            snapshot = probe("octoprint", url + "/octo/", token, fixture=True)

        self.assertEqual([request[1] for request in requests], list(routes))
        self.assertTrue(all(request[0] == "GET" for request in requests))
        self.assertTrue(all(request[2].get("X-Api-Key") == token for request in requests))
        self.assertNotIn("X-Octoprint-Api-Version", requests[0][2])
        self.assertEqual(requests[1][2]["X-Octoprint-Api-Version"], "2.0.0")
        self.assertTrue(snapshot["service_reachable"])
        self.assertTrue(snapshot["device_connected"])
        self.assertEqual(snapshot["device_state"], "printing")
        self.assertEqual(snapshot["temperatures"]["nozzle"], {"actual_c": 212.5, "target_c": 215})
        self.assertEqual(snapshot["job"]["progress_percent"], 43.5)
        self.assertEqual(snapshot["job"]["remaining_seconds"], 21)
        evidence = json.dumps(snapshot)
        self.assertNotIn(token, evidence)
        self.assertNotIn(url, evidence)
        self.assertNotIn("private-part", evidence)

    def test_octoprint_disconnected_printer_uses_connection_status(self):
        routes = {
            "/api/version": ok({"text": "OctoPrint 1.10.0", "server": "1.10.0"}),
            "/api/printer": (409, {}, {}),
            "/api/connection": ok({"current": {"state": "Closed", "port": "private serial path"}}),
        }
        with fixture(routes) as (url, requests):
            snapshot = probe("octoprint", url, fixture=True)

        self.assertTrue(snapshot["service_reachable"])
        self.assertFalse(snapshot["device_connected"])
        self.assertEqual(snapshot["device_state"], "offline")
        self.assertEqual([request[1] for request in requests], list(routes))
        self.assertNotIn("X-Octoprint-Api-Version", requests[1][2])

    def test_moonraker_maps_fraction_and_leaves_device_unknown_fields_empty(self):
        routes = {
            "/server/info": ok({"result": {
                "moonraker_version": "v0.9.3-102-g29cdd72", "klippy_connected": True, "klippy_state": "ready",
            }}),
            MOONRAKER_QUERY: ok({"result": {"status": {
                "webhooks": {"state": "ready"},
                "print_stats": {
                    "state": "paused", "print_duration": 21, "filament_used": 73.5,
                    "info": {"total_layer": 44, "current_layer": 15},
                },
                "virtual_sdcard": {"progress": 0.375, "is_active": False},
                "extruder": {"temperature": 203.125, "target": 210.0},
                "heater_bed": {"temperature": 42.9, "target": 52.0},
            }}}),
        }
        with fixture(routes) as (url, requests):
            snapshot = probe("moonraker", url, fixture=True)

        self.assertEqual(snapshot["source"], "loopback_fixture")
        self.assertEqual(snapshot["device_state"], "paused")
        self.assertEqual(snapshot["job"]["progress_percent"], 37.5)
        self.assertEqual(snapshot["job"]["current_layer"], 15)
        self.assertIsNone(snapshot["job"]["remaining_seconds"])
        self.assertEqual(snapshot["temperatures"]["bed"]["actual_c"], 42.9)
        self.assertEqual(parse_qs(urlsplit(requests[-1][1]).query)["webhooks"], ["state"])

    def test_moonraker_firmware_disconnection_is_not_service_disconnection(self):
        routes = {
            "/server/info": ok({"result": {"klippy_connected": False, "klippy_state": "disconnected"}}),
        }
        with fixture(routes) as (url, requests):
            snapshot = probe("moonraker", url, fixture=True)
        self.assertEqual(len(requests), 1)
        self.assertTrue(snapshot["service_reachable"])
        self.assertFalse(snapshot["device_connected"])
        self.assertEqual(snapshot["device_state"], "offline")

    def test_missing_status_is_never_inferred_as_idle(self):
        routes = {
            "/server/info": ok({"result": {"klippy_connected": True, "klippy_state": "ready"}}),
            MOONRAKER_QUERY: ok({"result": {"status": {"webhooks": {"state": "ready"}}}}),
        }
        with fixture(routes) as (url, _):
            snapshot = probe("moonraker", url, fixture=True)
        self.assertEqual(snapshot["device_state"], "unknown")
        self.assertEqual(snapshot["checks"][-1]["error"], "unrecognized_status_payload")

    def test_authentication_and_malformed_payloads_stay_unknown(self):
        for code, body, expected in (
            (403, b"private response", "authentication_or_permission"),
            (200, b"<html>log in again</html>", "unexpected_response"),
            (200, b"{}", "unrecognized_status_payload"),
        ):
            with self.subTest(code=code, expected=expected):
                with fixture({"/server/info": (code, {}, body)}) as (url, requests):
                    snapshot = probe("moonraker", url, fixture=True)
                self.assertEqual(len(requests), 1)
                self.assertEqual(snapshot["device_state"], "unknown")
                self.assertIsNone(snapshot["device_connected"])
                self.assertEqual(snapshot["checks"][0]["error"], expected)

    def test_redirect_is_rejected_without_forwarding_header(self):
        with fixture({}) as (other_url, other_requests):
            routes = {"/api/version": (302, {"Location": other_url + "/other"}, {})}
            with fixture(routes) as (url, requests):
                snapshot = probe("octoprint", url, "fixture-credential", fixture=True)
        self.assertEqual(len(requests), 1)
        self.assertEqual(other_requests, [])
        self.assertEqual(snapshot["checks"][0]["error"], "redirect_rejected")
        self.assertEqual(snapshot["device_state"], "unknown")

    def test_cli_writes_local_fixture_evidence_and_does_not_overwrite_it(self):
        routes = {
            "/api/version": ok({"text": "OctoPrint 1.10.0", "server": "1.10.0"}),
            "/api/printer": ok({"state": {"flags": {"operational": True, "ready": True}}}),
        }
        probe_path = Path(__file__).with_name("probe.py")
        environment = dict(os.environ)
        environment.pop(API_KEY_ENV, None)
        with TemporaryDirectory(dir=str(probe_path.parent)) as directory, fixture(routes) as (url, _):
            output = Path(directory) / "fixture.json"
            command = [sys.executable, "-B", str(probe_path), "octoprint", "--url", url,
                       "--fixture", "--output", str(output)]
            result = subprocess.run(command, env=environment, capture_output=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            evidence = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(evidence, json.loads(result.stdout))
            self.assertEqual(evidence["source"], "loopback_fixture")
            self.assertEqual(evidence["device_state"], "idle")
            collision = subprocess.run(command, env=environment, capture_output=True, timeout=30)
            self.assertEqual(collision.returncode, 2)
            self.assertEqual(evidence, json.loads(output.read_text(encoding="utf-8")))

    def test_fixture_rejects_nonloopback_and_credentials_cannot_enter_urls(self):
        for invalid in ("http://192.0.2.10", "http://u:pass@127.0.0.1", "http://127.0.0.1?api_key=secret"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    endpoint_url(invalid, fixture=True)


if __name__ == "__main__":
    unittest.main()

"""Read a single status snapshot from an explicitly configured printer service."""

import argparse
from datetime import datetime, timezone
import getpass
from http.client import HTTPException
import ipaddress
import json
import math
import os
import re
import socket
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import warnings


API_KEY_ENV = "PRINT_GATEWAY_API_KEY"
MAX_RESPONSE_BYTES = 512 * 1024
VERSION_PATTERN = r"v?[0-9]{1,8}(?:\.[0-9]{1,8}){1,3}(?:[a-z0-9.+-]{0,48})"
OCTOPRINT_STATES = {
    "operational": "idle",
    "printing": "printing",
    "paused": "paused",
    "pausing": "busy",
    "resuming": "busy",
    "cancelling": "busy",
    "finishing": "busy",
    "starting": "busy",
    "transferring file": "busy",
    "error": "error",
    "closed with error": "error",
    "offline": "offline",
    "closed": "offline",
    "connecting": "connecting",
    "detecting serial connection": "connecting",
    "opening serial connection": "connecting",
}
MOONRAKER_CONTROLLER = {
    "disconnected": "offline", "startup": "connecting", "error": "error",
    "shutdown": "error", "ready": "unknown",
}
MOONRAKER_JOBS = {
    "standby": ("idle", None),
    "printing": ("printing", "printing"),
    "paused": ("paused", "paused"),
    "complete": ("idle", "completed"),
    "cancelled": ("idle", "cancelled"),
    "error": ("error", "failed"),
}
MOONRAKER_QUERY = (
    "/printer/objects/query?webhooks=state&print_stats=state,print_duration,filament_used,info"
    "&virtual_sdcard=progress,is_active&extruder=temperature,target&heater_bed=temperature,target"
)


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint_url(value, fixture):
    if not value or any(char.isspace() or ord(char) == 127 for char in value):
        raise ValueError("invalid_endpoint")
    if any(char in value for char in "\\?#@") or any(ord(char) < 32 for char in value):
        raise ValueError("invalid_endpoint")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.port == 0:
        raise ValueError("invalid_endpoint")
    if parsed.path and not re.fullmatch(r"(?:/[A-Za-z0-9._~-]+)*/?", parsed.path):
        raise ValueError("invalid_endpoint")
    if {".", ".."}.intersection(parsed.path.split("/")):
        raise ValueError("invalid_endpoint")
    if fixture and not ipaddress.ip_address(parsed.hostname).is_loopback:
        raise ValueError("fixture_requires_loopback_ip")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


class StatusReader:
    def __init__(self, base_url, api_key, timeout):
        self.base_url = base_url
        self.api_key = api_key
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), RejectRedirects())
        self.checks = []
        self.octoprint_v2 = False

    def get(self, source, route):
        headers = {"Accept": "application/json", "User-Agent": "ai-3d-print-status-probe/1"}
        if self.api_key:
            headers["X-Api-Key"] = self.api_key
        if self.octoprint_v2:
            headers["X-OctoPrint-Api-Version"] = "2.0.0"
        status = None
        payload = {}
        try:
            request = Request(self.base_url + route, headers=headers, method="GET")
            with self.opener.open(request, timeout=self.timeout) as response:
                status = response.status
                content = response.read(MAX_RESPONSE_BYTES + 1)
                if len(content) > MAX_RESPONSE_BYTES:
                    error = "response_too_large"
                else:
                    decoded = json.loads(content)
                    error = None if isinstance(decoded, dict) else "unexpected_response"
                    if error is None:
                        payload = decoded
        except HTTPError as exc:
            status = exc.code
            exc.close()
            if status in (401, 403):
                error = "authentication_or_permission"
            elif 300 <= status < 400:
                error = "redirect_rejected"
            else:
                error = "http_error"
        except URLError as exc:
            if isinstance(exc.reason, ssl.SSLError):
                error = "tls_error"
            elif isinstance(exc.reason, (TimeoutError, socket.timeout)):
                error = "timeout"
            else:
                error = "unreachable"
        except (TimeoutError, socket.timeout):
            error = "timeout"
        except ssl.SSLError:
            error = "tls_error"
        except (UnicodeError, ValueError, RecursionError):
            error = "unexpected_response"
        except (OSError, HTTPException):
            error = "connection_interrupted"
        self.checks.append({"source": source, "http_status": status, "error": error})
        return payload

    def invalid_payload(self):
        if self.checks[-1]["error"] is None:
            self.checks[-1]["error"] = "unrecognized_status_payload"

    def version(self, value):
        if isinstance(value, str) and re.fullmatch(VERSION_PATTERN, value, re.IGNORECASE):
            if not self.api_key or self.api_key not in value:
                return value
        return None


def fields(value):
    return value if isinstance(value, dict) else {}


def number(value, minimum, maximum):
    if type(value) in (int, float) and minimum <= value <= maximum and math.isfinite(value):
        return value
    return None


def temperature(values, actual_field):
    values = fields(values)
    actual = number(values.get(actual_field), -100, 1_500)
    target = number(values.get("target"), 0, 1_500)
    if actual is not None or target is not None:
        return {"actual_c": actual, "target_c": target}
    return None


def canonical_state(value, mapping):
    return mapping.get(value.casefold(), "unknown") if isinstance(value, str) else "unknown"


def octoprint_state(state):
    flags = fields(state.get("flags"))
    if flags.get("error") is True:
        return "error"
    if flags.get("closedOrError") is True:
        reported = canonical_state(state.get("text"), OCTOPRINT_STATES)
        return reported if reported in ("error", "offline", "connecting") else "unknown"
    if any(flags.get(key) is True for key in ("cancelling", "pausing", "resuming", "finishing", "starting")):
        return "busy"
    if flags.get("paused") is True:
        return "paused"
    if flags.get("printing") is True:
        return "printing"
    if flags.get("operational") is True and flags.get("ready") is True:
        return "idle"
    return canonical_state(state.get("text"), OCTOPRINT_STATES)


def read_octoprint(reader, evidence):
    version = reader.get("version", "/api/version")
    product = version.get("text")
    if not isinstance(product, str) or not product.startswith("OctoPrint "):
        reader.invalid_payload()
        return
    evidence["service_version"] = reader.version(version.get("server"))
    parsed_version = evidence["service_version"]
    if parsed_version:
        reader.octoprint_v2 = int(parsed_version.lstrip("vV").split(".")[0]) >= 2
    printer = reader.get("printer", "/api/printer")
    if reader.checks[-1]["http_status"] == 409:
        connection = reader.get("connection", "/api/connection")
        current = fields(connection.get("current"))
        state = canonical_state(current.get("state"), OCTOPRINT_STATES)
        if state in ("offline", "connecting", "error"):
            evidence.update(device_state=state, device_connected=False)
        else:
            reader.invalid_payload()
        return

    state = octoprint_state(fields(printer.get("state")))
    evidence["device_state"] = state
    if state != "unknown":
        evidence["device_connected"] = state not in ("offline", "connecting")
    else:
        reader.invalid_payload()
    temperatures = fields(printer.get("temperature"))
    evidence["temperatures"] = {
        "nozzle": temperature(temperatures.get("tool0"), "actual"),
        "bed": temperature(temperatures.get("bed"), "actual"),
    }
    if state in ("printing", "paused"):
        job = reader.get("job", "/api/job")
        if canonical_state(job.get("state"), OCTOPRINT_STATES) == state:
            progress = fields(job.get("progress"))
            evidence["job"].update(
                state=state,
                progress_percent=number(progress.get("completion"), 0, 100),
                elapsed_seconds=number(progress.get("printTime"), 0, 100_000_000),
                remaining_seconds=number(progress.get("printTimeLeft"), 0, 100_000_000),
            )
        else:
            reader.invalid_payload()


def read_moonraker(reader, evidence):
    envelope = reader.get("server_info", "/server/info")
    server = fields(envelope.get("result"))
    controller = server.get("klippy_state")
    connected = server.get("klippy_connected")
    if not isinstance(controller, str) or controller not in MOONRAKER_CONTROLLER or type(connected) is not bool:
        reader.invalid_payload()
        return
    evidence["service_version"] = reader.version(server.get("moonraker_version"))
    evidence["device_connected"] = connected
    evidence["device_state"] = MOONRAKER_CONTROLLER[controller]
    if not connected or controller != "ready":
        return

    envelope = reader.get("printer_objects", MOONRAKER_QUERY)
    status = fields(fields(envelope.get("result")).get("status"))
    controller = fields(status.get("webhooks")).get("state")
    if controller != "ready":
        evidence["device_state"] = canonical_state(controller, MOONRAKER_CONTROLLER)
        if controller == "disconnected":
            evidence["device_connected"] = False
        elif evidence["device_state"] == "unknown":
            reader.invalid_payload()
        return

    stats = fields(status.get("print_stats"))
    sd = fields(status.get("virtual_sdcard"))
    job_status = stats.get("state")
    if isinstance(job_status, str):
        device_state, job_state = MOONRAKER_JOBS.get(job_status, ("unknown", None))
        if sd.get("is_active") is True and device_state == "idle":
            device_state, job_state = "busy", None
        evidence["device_state"] = device_state
        evidence["job"]["state"] = job_state
    if evidence["device_state"] == "unknown":
        reader.invalid_payload()
    evidence["temperatures"] = {
        "nozzle": temperature(status.get("extruder"), "temperature"),
        "bed": temperature(status.get("heater_bed"), "temperature"),
    }
    if evidence["job"]["state"] in ("printing", "paused"):
        progress = number(sd.get("progress"), 0, 1)
        layers = fields(stats.get("info"))
        evidence["job"].update(
            progress_percent=progress * 100 if progress is not None else None,
            elapsed_seconds=number(stats.get("print_duration"), 0, 100_000_000),
            filament_used_mm=number(stats.get("filament_used"), 0, 100_000_000),
            current_layer=number(layers.get("current_layer"), 0, 10_000_000),
            total_layers=number(layers.get("total_layer"), 0, 10_000_000),
        )


def probe(protocol, base_url, api_key=None, timeout=5.0, fixture=False):
    reader = StatusReader(endpoint_url(base_url, fixture), api_key, timeout)
    evidence = {
        "schema_version": 1,
        "observed_at_utc": None,
        "source": "loopback_fixture" if fixture else "configured_endpoint",
        "protocol": protocol,
        "service_reachable": False,
        "service_version": None,
        "device_connected": None,
        "device_state": "unknown",
        "temperatures": {"nozzle": None, "bed": None},
        "job": {
            "state": None, "progress_percent": None, "elapsed_seconds": None,
            "remaining_seconds": None, "filament_used_mm": None,
            "current_layer": None, "total_layers": None,
        },
        "checks": reader.checks,
    }
    {"octoprint": read_octoprint, "moonraker": read_moonraker}[protocol](reader, evidence)
    evidence["observed_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    evidence["service_reachable"] = any(check["http_status"] is not None for check in reader.checks)
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("protocol", choices=("octoprint", "moonraker"))
    parser.add_argument("--url", required=True, help="Base URL of the configured service")
    parser.add_argument("--prompt-key", action="store_true", help="Enter the API key without echo")
    parser.add_argument("--timeout", type=float, default=5.0, help="Timeout per request in seconds")
    parser.add_argument("--output", help="Also save the sanitized snapshot to a new JSON file")
    parser.add_argument("--fixture", action="store_true", help="Mark loopback-only test data")
    args = parser.parse_args(argv)
    if not 0.1 <= args.timeout <= 30:
        parser.error("--timeout must be between 0.1 and 30 seconds")
    try:
        endpoint_url(args.url, args.fixture)
    except ValueError:
        parser.error("provide an HTTP(S) base URL without credentials, query or fragment. Fixtures require a loopback IP")

    api_key = os.environ.get(API_KEY_ENV)
    if args.prompt_key:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                api_key = getpass.getpass("Printer API key: ")
        except (EOFError, getpass.GetPassWarning):
            parser.error("a console with hidden input is required for --prompt-key")
    if api_key and not re.fullmatch(r"[!-~]{1,512}", api_key):
        parser.error("invalid API key format")
    evidence = probe(args.protocol, args.url, api_key, args.timeout, args.fixture)
    data = json.dumps(evidence, indent=2, allow_nan=False)
    if args.output:
        try:
            with open(args.output, "x", encoding="utf-8") as output:
                output.write(data + "\n")
        except OSError:
            print("Could not create the evidence file. Choose a new file path.", file=sys.stderr)
            return 2
    print(data)
    if evidence["device_connected"] is True and evidence["device_state"] != "unknown":
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

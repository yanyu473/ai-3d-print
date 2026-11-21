import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from zipfile import ZipFile

from inspect_gcode import inspect_gcode


PLATE_GCODE = re.compile(r"Metadata/plate_\d+\.gcode")


def input_file(path: Path, suffix: str) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.suffix.lower() != suffix:
        raise ValueError(f"Expected a {suffix} file: {path}")
    return resolved


def describe_file(path: Path) -> dict:
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    return {"name": path.name, "sha256": digest, "bytes": path.stat().st_size}


def capture_toolpath(project: Path, destination: Path) -> Path:
    with ZipFile(project) as archive:
        plates = [member for member in archive.infolist() if PLATE_GCODE.fullmatch(member.filename)]
        if len(plates) != 1 or not 1 <= plates[0].file_size <= 128 * 1024 * 1024:
            raise ValueError("Expected exactly one bounded printable plate in the OrcaSlicer export")
        output = destination / Path(plates[0].filename).name
        with archive.open(plates[0]) as source, output.open("xb") as target:
            shutil.copyfileobj(source, target)
        return output


def run_probe(args: argparse.Namespace) -> dict:
    exe = input_file(args.orca, ".exe")
    model = input_file(args.stl, ".stl")
    profiles = {
        kind: input_file(getattr(args, kind), ".json")
        for kind in ("process", "machine", "filament")
    }
    if any(";" in str(path) for path in (profiles["process"], profiles["machine"], profiles["filament"])):
        raise ValueError("OrcaSlicer uses semicolon-separated profile paths")
    for kind, path in profiles.items():
        if not isinstance(json.loads(path.read_text(encoding="utf-8-sig")), dict):
            raise ValueError(f"Expected an exported OrcaSlicer {kind} preset JSON object")

    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    project = destination / "sliced.3mf"
    log = destination / "orca.log"
    command = [
        str(exe), "--datadir", str(destination / "orca-data"),
        "--outputdir", str(destination), "--debug", "3", "--logfile", str(log),
        "--load-settings", f'{profiles["process"]};{profiles["machine"]}',
        "--load-filaments", str(profiles["filament"]),
        "--arrange", "1", "--slice", "0", "--mstpp", "120",
        "--export-3mf", project.name, "--", str(model),
    ]
    started = time.perf_counter()
    with (destination / "cli-output.log").open("wb") as output:
        completed = subprocess.run(
            command, cwd=destination, stdout=output, stderr=subprocess.STDOUT,
            timeout=180, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    if completed.returncode != 0 or not project.is_file():
        raise RuntimeError(f"OrcaSlicer did not produce a sliced project (exit {completed.returncode}). See {destination}.")

    toolpath = capture_toolpath(project, destination)
    report = {
        "engine": "OrcaSlicer native CLI",
        "executable": describe_file(exe),
        "source": describe_file(model),
        "profiles": {kind: describe_file(path) for kind, path in profiles.items()},
        "project": describe_file(project),
        "toolpath": {"name": toolpath.name, **inspect_gcode(toolpath)},
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "device_verification": "pending",
    }
    (destination / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run an offline OrcaSlicer native CLI probe on one STL")
    for option in ("orca", "stl", "process", "machine", "filament", "output"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    print(json.dumps(run_probe(parser.parse_args()), indent=2))

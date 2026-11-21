"""Install the pinned headless WASM engine into the project tool directory."""

import argparse
from base64 import b64encode
from hashlib import sha512
from io import BytesIO
from pathlib import Path
import tarfile
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.4.3"
INTEGRITY = "FM+mADNXArkXqfi0DVPM1lI/VGGA4wroJS8rsy2+cdV91Bo7UPi/OlDjPEFSGquWeQmZOTMHZhmF2kZ+Xy1jsQ=="
DESTINATION = ROOT / ".tools" / "alternative-slicers" / f"three-slicer-{VERSION}"


def provision(registry):
    if urlsplit(registry).scheme != "https":
        raise ValueError("Select an HTTPS package registry")
    if DESTINATION.exists():
        raise FileExistsError(f"Package directory already exists: {DESTINATION}")
    filename = f"three-slicer-{VERSION}.tgz"
    url = f"{registry.rstrip('/')}/three-slicer/-/{filename}"
    with urlopen(url, timeout=30) as response:
        payload = response.read(10_000_000)
    if b64encode(sha512(payload).digest()).decode("ascii") != INTEGRITY:
        raise ValueError("Registry archive failed the pinned SHA-512 integrity check")
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="three-slicer-", dir=DESTINATION.parent) as temporary:
        work = Path(temporary) / "result"
        work.mkdir()
        with tarfile.open(fileobj=BytesIO(payload), mode="r:gz") as archive:
            archive.extractall(work, filter="data")
        (work / filename).write_bytes(payload)
        (work / "download-source.txt").write_text(f"{url}\nsha512-{INTEGRITY}\n", encoding="utf8")
        work.rename(DESTINATION)
    print(f"Installed verified npm archive to {DESTINATION}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default="https://registry.npmjs.org")
    args = parser.parse_args()
    provision(args.registry)

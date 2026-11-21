"""Exercise the real CAD CLI and check its persisted results."""

from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "cad-worker" / "build_plate.py"
FIXTURE = ROOT / "cad-worker" / "fixtures" / "mounting-plate.json"


class CADProbeTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(prefix="cad-test-", dir=ROOT)
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)

    def run_builder(self, spec, output):
        return subprocess.run(
            [sys.executable, str(BUILDER), "--spec", str(spec), "--out", str(output)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )

    def write_spec(self, name, parameter, value):
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        spec["parameters"][parameter] = {"value": value, "source": "user_declared"}
        path = self.work / name
        path.write_text(json.dumps(spec), encoding="utf-8")
        return path

    def read_verified_report(self, out, dimensions):
        report = json.loads((out / "verification.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "verified")
        self.assertEqual(set(report["assets"]), {"step", "stl", "glb"})
        for extension, asset in report["assets"].items():
            with self.subTest(extension=extension):
                content = (out / asset["file"]).read_bytes()
                self.assertGreater(asset["bytes"], 0)
                self.assertEqual(len(content), asset["bytes"])
                self.assertEqual(sha256(content).hexdigest(), asset["sha256"])
                for actual, expected in zip(asset["checks"]["dimensions_mm_xyz"], dimensions, strict=True):
                    self.assertAlmostEqual(actual, expected, delta=0.001)
        step = report["assets"]["step"]["checks"]
        self.assertEqual(step["solid_count"], 1)
        holes = step["through_holes_xy_diameter_depth_mm"]
        self.assertEqual(len(holes), 4)
        for actual, expected in zip(holes, ((-23, -13), (-23, 13), (23, -13), (23, 13)), strict=True):
            for measured, design in zip(actual, (*expected, 4, dimensions[2]), strict=True):
                self.assertAlmostEqual(measured, design, delta=0.001)
        for extension in ("stl", "glb"):
            mesh = report["assets"][extension]["checks"]
            self.assertTrue(mesh["watertight"])
            self.assertTrue(mesh["winding_consistent"])
        return report

    def test_revision_rebuild_preserves_previous_assets(self):
        original, revised = self.work / "original", self.work / "revised"
        edit = self.write_spec("edited.json", "thickness", 7)

        first = self.run_builder(FIXTURE, original)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        first_report = self.read_verified_report(original, (60, 40, 5))
        second = self.run_builder(edit, revised)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        second_report = self.read_verified_report(revised, (60, 40, 7))

        for extension in first_report["assets"]:
            self.assertNotEqual(
                first_report["assets"][extension]["sha256"], second_report["assets"][extension]["sha256"]
            )
        self.assertEqual(self.read_verified_report(original, (60, 40, 5)), first_report)

        collision = self.run_builder(edit, original)
        self.assertNotEqual(collision.returncode, 0)
        self.assertIn("Choose a new output directory", collision.stderr)
        self.assertEqual(self.read_verified_report(original, (60, 40, 5)), first_report)

    def test_rejects_holes_that_overflow_the_plate(self):
        invalid = self.write_spec("invalid.json", "hole_diameter", 15)
        output = self.work / "invalid-output"
        result = self.run_builder(invalid, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("strictly inside the plate", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()

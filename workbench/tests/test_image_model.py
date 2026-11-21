from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw
import trimesh


PROJECT = Path(__file__).resolve().parents[2]
BUILDER = PROJECT / "workbench" / "image_model.py"


class ImageModelTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(prefix="image-model-test-", dir=PROJECT)
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)

    def model(self, source, output):
        return subprocess.run(
            [sys.executable, str(BUILDER), "--input", str(source), "--width", "60",
             "--thickness", "5", "--out", str(output)],
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )

    def verify(self, output, holes):
        report = json.loads((output / "verification.json").read_text(encoding="utf-8"))
        self.assertEqual(report["method"], "single_view_silhouette_extrusion")
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["source"]["through_hole_count"], holes)
        for extension, asset in report["assets"].items():
            payload = (output / asset["file"]).read_bytes()
            self.assertEqual(len(payload), asset["bytes"])
            self.assertEqual(sha256(payload).hexdigest(), asset["sha256"])
            self.assertTrue(asset["checks"]["watertight"])
            self.assertEqual(asset["checks"]["through_hole_count"], holes)
            mesh = trimesh.load_scene(output / asset["file"]).to_mesh()
            mesh.merge_vertices(merge_tex=True, merge_norm=True)
            self.assertTrue(mesh.is_volume)
            self.assertEqual(mesh.euler_number, 2 - 2 * holes)
            if extension == "stl":
                self.assertAlmostEqual(mesh.bounds[0, 2], 0, places=4)
                self.assertAlmostEqual(mesh.extents[0], 60, places=3)
                self.assertAlmostEqual(mesh.extents[2], 5, places=3)
            else:
                self.assertAlmostEqual(mesh.bounds[0, 1], 0, places=6)
                self.assertAlmostEqual(mesh.extents[0], 0.06, places=6)
                self.assertAlmostEqual(mesh.extents[1], 0.005, places=6)
        return report

    def test_different_pixels_change_geometry_and_preserve_holes(self):
        plain = Image.new("L", (120, 100), color=255)
        ImageDraw.Draw(plain).rectangle((30, 25, 89, 64), fill=0)
        perforated = plain.copy()
        ImageDraw.Draw(perforated).ellipse((50, 34, 60, 44), fill=255)
        first, second = self.work / "plain.png", self.work / "hole.png"
        plain.save(first)
        perforated.save(second)
        plain_output, perforated_output = self.work / "plain", self.work / "perforated"
        for source, output in ((first, plain_output), (second, perforated_output)):
            result = self.model(source, output)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        solid = self.verify(plain_output, holes=0)
        ring = self.verify(perforated_output, holes=1)
        self.assertNotEqual(solid["source"]["sha256"], ring["source"]["sha256"])
        for extension in ("stl", "glb"):
            self.assertNotEqual(solid["assets"][extension]["sha256"], ring["assets"][extension]["sha256"])
            self.assertGreater(solid["assets"][extension]["checks"]["volume_mm3"],
                               ring["assets"][extension]["checks"]["volume_mm3"])

    def test_dark_background_jpeg_and_transparent_webp(self):
        for extension, mode, background, subject in (
            ("jpg", "RGB", "black", "white"),
            ("webp", "RGBA", (0, 0, 0, 0), "white"),
        ):
            with self.subTest(extension=extension):
                source = self.work / f"photo.{extension}"
                image = Image.new(mode, (120, 100), color=background)
                ImageDraw.Draw(image).rectangle((30, 25, 89, 64), fill=subject)
                image.save(source)
                output = self.work / extension
                result = self.model(source, output)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                report = self.verify(output, holes=0)
                expected_signal = "alpha" if extension == "webp" else "grayscale"
                self.assertEqual(report["source"]["segmentation_source"], expected_signal)

    def test_low_contrast_is_rejected_without_partial_output(self):
        source = self.work / "low-contrast.png"
        image = Image.new("L", (120, 100), color=150)
        ImageDraw.Draw(image).rectangle((30, 25, 89, 64), fill=165)
        image.save(source)
        out = self.work / "failed"
        result = self.model(source, out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stronger contrast", result.stderr)
        self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()

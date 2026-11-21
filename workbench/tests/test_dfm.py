from hashlib import sha256
import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

import trimesh

from workbench.dfm import assess


PROFILE = Path(__file__).resolve().parents[2] / "slicer-wasm" / "profile.json"


def plate_with_square_opening(clearance: float) -> trimesh.Trimesh:
    outer = [(-5, -5), (5, -5), (5, 5), (-5, 5)]
    inner = [(-2, -2), (5 - clearance, -2), (5 - clearance, 2), (-2, 2)]
    vertices = [(x, y, z) for z in (0, 2) for x, y in outer + inner]
    faces = []
    for start in range(4):
        end = (start + 1) % 4
        faces.extend([
            (8 + start, 8 + end, 12 + end), (8 + start, 12 + end, 12 + start),
            (start, 4 + end, end), (start, 4 + start, 4 + end),
            (start, end, 8 + end), (start, 8 + end, 8 + start),
            (4 + start, 12 + end, 4 + end), (4 + start, 12 + start, 12 + end),
        ])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


class DfmTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(dir=PROFILE.parent.parent / "workbench")
        self.addCleanup(temporary.cleanup)
        self.model = Path(temporary.name)
        self.stl = self.model / "model.stl"

    def write_model(self, model: trimesh.Trimesh | bytes) -> None:
        raw = model.export(file_type="stl") if isinstance(model, trimesh.Trimesh) else model
        self.stl.write_bytes(raw)
        manifest = {"assets": {"stl": {"sha256": sha256(raw).hexdigest(), "checks": {"watertight": True}}}}
        (self.model / "verification.json").write_text(json.dumps(manifest), encoding="utf-8")

    def report(self) -> tuple[dict, dict]:
        report = assess(self.model, PROFILE)
        checks = {check["id"]: check for check in report["checks"]}
        self.assertTrue(all({"label", "status", "detail"} <= check.keys() for check in checks.values()))
        self.assertEqual(report["profile_sha256"], sha256(PROFILE.read_bytes()).hexdigest())
        return report, checks

    def test_flat_plate_reports_measured_features_and_analysis_limits(self) -> None:
        self.write_model(plate_with_square_opening(2.0))
        report, checks = self.report()
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["geometry"]["dimensions_mm"], [10.0, 10.0, 2.0])
        self.assertAlmostEqual(checks["planar_ligament"]["measured_mm"], 2.0)
        self.assertEqual(checks["planar_ligament"]["boundary_loops"], 2)
        self.assertEqual(checks["extrusion_height"]["measured_mm"], 2.0)
        self.assertEqual(checks["global_wall_thickness"]["status"], "not_checked")
        self.assertEqual(checks["self_intersection"]["status"], "not_checked")
        self.assertEqual(checks["target_printer"]["status"], "not_checked")

    def test_ligament_narrower_than_one_line_blocks_slicing(self) -> None:
        self.write_model(plate_with_square_opening(0.30))
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["can_slice"])
        self.assertAlmostEqual(checks["planar_ligament"]["measured_mm"], 0.30, places=6)
        self.assertEqual(checks["planar_ligament"]["status"], "fail")

    def test_ligament_narrower_than_two_lines_warns(self) -> None:
        self.write_model(plate_with_square_opening(0.6))
        report, checks = self.report()
        self.assertEqual(report["status"], "warn")
        self.assertTrue(report["can_slice"])
        self.assertEqual(checks["planar_ligament"]["status"], "warn")

    def test_bed_fit_and_thin_z_fail_independently(self) -> None:
        self.write_model(trimesh.creation.box(extents=[221, 15, 0.1]))
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["bed_envelope"]["exceeds"], ["X"])
        self.assertEqual(checks["extrusion_height"]["status"], "fail")

    def test_sphere_does_not_report_flat_plate_thickness(self) -> None:
        self.write_model(trimesh.creation.icosphere(subdivisions=1, radius=5))
        report, checks = self.report()
        self.assertEqual(report["status"], "warn")
        self.assertEqual(checks["extrusion_height"]["status"], "not_checked")

    def test_missing_face_blocks_even_when_manifest_claims_watertight(self) -> None:
        mesh = trimesh.creation.box()
        mesh.update_faces(range(len(mesh.faces) - 1))
        self.write_model(mesh)
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["watertight"]["status"], "fail")

    def test_inward_oriented_closed_mesh_fails_signed_volume(self) -> None:
        mesh = trimesh.creation.box()
        mesh.invert()
        self.write_model(mesh)
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["winding"]["status"], "pass")
        self.assertEqual(checks["positive_volumes"]["status"], "fail")

    def test_disjoint_shells_report_component_count(self) -> None:
        first = trimesh.creation.box()
        second = first.copy().apply_translation([4, 0, 0])
        self.write_model(trimesh.util.concatenate((first, second)))
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["components"]["count"], 2)
        self.assertEqual(checks["positive_volumes"]["status"], "pass")

    def test_changed_stl_is_rejected_even_if_geometry_is_same(self) -> None:
        self.write_model(trimesh.creation.box())
        raw = self.stl.read_bytes()
        self.stl.write_bytes(b"Z" + raw[1:])
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["stl_identity"]["status"], "fail")
        self.assertEqual(checks["watertight"]["status"], "pass")

    def test_nonfinite_stl_coordinates_block_slicing(self) -> None:
        raw = bytearray(trimesh.creation.box().export(file_type="stl"))
        struct.pack_into("<f", raw, 96, float("nan"))
        self.write_model(bytes(raw))
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(checks["finite_mesh"]["status"], "fail")

    def test_no_stl_produces_safe_blocked_report(self) -> None:
        report, checks = self.report()
        self.assertEqual(report["status"], "blocked")
        self.assertIsNone(report["model_sha256"])
        self.assertEqual(checks["stl_source"]["status"], "fail")


if __name__ == "__main__":
    unittest.main()

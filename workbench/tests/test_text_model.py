from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sys
import unittest


WORKBENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKBENCH))
from text_model import build_cad, read_spec


BRACKET = "加强角码，长 48 mm，宽 38 mm，高 36 mm，壁厚 4 mm，孔径 5 mm"
TRAY = "电子盒底座，长 62 mm，宽 44 mm，高 20 mm，壁厚 2.4 mm，螺丝柱直径 7 mm，孔径 2.8 mm"


class TextModelTests(unittest.TestCase):
    def test_plate_uses_user_supplied_hole_dimensions(self):
        spec = read_spec("60×40×5 mm 四孔矩形板，孔径 3.5 mm，孔中心距 46×26 mm")
        self.assertEqual(spec["kind"], "four_hole_plate")
        self.assertEqual(spec["parameters"]["hole_diameter"]["value"], 3.5)
        self.assertEqual(spec["parameters"]["x_spacing"], {"value": 46, "source": "user_declared"})
        self.assertEqual(spec["parameters"]["y_spacing"]["value"], 26)

    def test_parse_rejects_unsupported_features_and_units(self):
        for text in (
            "直径 6 cm 高 5 mm 的圆柱",
            "直径 0.03 m 高 5 mm 的圆柱",
            "60×40×5 mm 安装板，两个安装孔",
            "60×40×5 mm 矩形板，带孔",
            "外径 20 mm，内径 25 mm，厚 4 mm 的垫圈",
        ):
            with self.subTest(text=text), self.assertRaises(ValueError):
                read_spec(text)

    def test_three_other_shapes_export_verified_assets(self):
        inputs = [
            ("长 40 宽 30 厚 5 mm 的矩形板", (40, 30, 5)),
            ("外径 32 mm，内径 12 mm，厚 4 mm 的垫圈", (32, 32, 4)),
            ("直径 24 mm，高 8 mm 的圆柱", (24, 24, 8)),
        ]
        with TemporaryDirectory(dir=WORKBENCH) as temporary:
            for index, (text, dimensions) in enumerate(inputs):
                with self.subTest(text=text):
                    output = Path(temporary) / str(index)
                    build_cad(read_spec(text), output)
                    report = json.loads((output / "verification.json").read_text(encoding="utf-8"))
                    self.assertEqual(report["assets"]["step"]["checks"]["dimensions_mm_xyz"], list(dimensions))
                    self.assertEqual(set(report["assets"]), {"step", "stl", "glb"})
                    self.assertTrue(report["assets"]["stl"]["checks"]["watertight"])

    def test_structural_counts_preserve_omitted_defaults_and_explicit_zero(self):
        for description, defaults, overrides in (
            (BRACKET, {"rib_count": 1, "base_hole_count": 2, "upright_hole_count": 2},
             "，加強筋 0 條，底板 四 孔，立板 0 孔"),
            (TRAY, {"compartment_count": 1, "post_count": 4, "cable_notch": 0},
             "，三 倉，0 個螺絲柱，出線口 關閉"),
        ):
            with self.subTest(description=description):
                base = read_spec(description)["parameters"]
                for key, value in defaults.items():
                    self.assertEqual(base[key], {"value": value, "source": "template_default"})
                changed = read_spec(description + overrides)["parameters"]
                for key in defaults:
                    self.assertEqual(changed[key]["source"], "user_declared")
                self.assertIn(0, [changed[key]["value"] for key in defaults])

    def test_structural_variants_reject_unsupported_or_colliding_layouts(self):
        for description in (
            BRACKET + "，底板 3 孔",
            BRACKET + "，加强筋 1.5 条",
            BRACKET.replace("孔径 5", "孔径 9") + "，加强筋 2 条，底板 4 孔",
            TRAY + "，4 仓",
            TRAY + "，2 个螺丝柱",
            TRAY + "，出线口 2",
            TRAY.replace("长 62", "长 22") + "，3 仓",
        ):
            with self.subTest(description=description), self.assertRaises(ValueError):
                read_spec(description)

    def test_bracket_and_tray_variants_roundtrip_structural_features(self):
        with TemporaryDirectory(dir=WORKBENCH) as temporary:
            for label, description in (
                ("bracket", BRACKET + "，加强筋 2 条，底板 4 孔，立板 0 孔"),
                ("tray", TRAY + "，3 仓，0 个螺丝柱，出线口 开启"),
            ):
                output = Path(temporary) / label
                build_cad(read_spec(description), output)
                report = json.loads((output / "verification.json").read_text(encoding="utf-8"))
                features = report["assets"]["step"]["checks"]["features"]
                self.assertEqual(report["features"], features)
                for mesh in ("stl", "glb"):
                    self.assertTrue(report["assets"][mesh]["checks"]["watertight"])
                if label == "bracket":
                    self.assertEqual(features["gussets"]["centers_x_mm"], [-6, 6])
                    self.assertEqual(features["base_holes"]["count"], 4)
                    self.assertEqual(features["upright_holes"]["count"], 0)
                else:
                    self.assertEqual(features["dividers"]["compartment_count"], 3)
                    self.assertEqual(features["dividers"]["count"], 2)
                    self.assertEqual(features["screw_posts"]["count"], 0)
                    self.assertTrue(features["cable_notch"]["enabled"])


if __name__ == "__main__":
    unittest.main()

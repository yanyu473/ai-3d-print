"""Turn supported natural-language dimensions into verified parametric CAD."""

import argparse
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "workbench"))
from structural_parts import STRUCTURES

NUMBER = r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)"
COUNT = rf"({NUMBER}|[零〇一二两兩三四五六七八九十百]+)"
EAST_ASIAN_COUNTS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "兩": 2, "三": 3, "四": 4}
MM = r"(?:\s*(?:mm|毫米))?"
TIMES = r"\s*[x×*]\s*"
TRIPLE = re.compile(rf"({NUMBER}){MM}{TIMES}({NUMBER}){MM}{TIMES}({NUMBER}){MM}", re.I)
PARTS = (
    ("reinforced_bracket", "加强角码", r"角[码碼]|角[撑撐]|直角支架|l\s*型支架|reinforced\s+bracket|angle\s+bracket"),
    ("electronics_tray", "电子盒底座", r"[电電]子盒|接[线線]盒底座|electronics\s+(?:tray|enclosure)"),
    ("four_hole_plate", "四孔安装板", r"四孔|4\s*(?:个)?孔|安装板|mounting\s+plate"),
    ("rectangle", "矩形板", r"矩形|长方形|长方体|方块|方板|实心块|rectangle|rectangular|cuboid"),
    ("washer", "垫圈", r"垫圈|圆环|垫片|washer|ring\b"),
    ("cylinder", "圆柱", r"圆柱|圆盘|圆片|cylinder|disc\b"),
)


def dimension(raw, label):
    if raw is None:
        raise ValueError(f"请在描述中补充{label}，单位为毫米。")
    value = float(raw)
    if not math.isfinite(value) or not 0.1 <= value <= 500:
        raise ValueError(f"{label}须在 0.1 至 500 毫米之间。")
    return value


def labeled(text, pattern):
    match = re.search(rf"(?:{pattern})\s*[:=]?\s*({NUMBER}){MM}", text, re.I)
    return match[1] if match else None


def read_spec(description):
    text = unicodedata.normalize("NFKC", description).casefold()
    if re.search(r"\d\s*(?:cm\b|dm\b|m\b|in(?:ch(?:es)?)?\b|ft\b|厘米|公分|英寸|米(?!米))", text):
        raise ValueError("请将所有尺寸换成毫米后提交。")
    if re.search(r"沉头|沉孔|螺纹|圆角|倒角|斜孔|齿轮|异形|空心盒|拼装|装配", text):
        raise ValueError("这段描述含有当前模板暂不支持的加工特征。")

    matches = [(kind, label) for kind, label, pattern in PARTS if re.search(pattern, text)]
    if any(kind in STRUCTURES for kind, _ in matches) and not re.search(r"安装板|mounting\s+plate", text):
        matches = [(kind, label) for kind, label in matches if kind != "four_hole_plate"]
    if [kind for kind, _ in matches] == ["four_hole_plate", "rectangle"]:
        matches.pop()
    if len(matches) != 1:
        raise ValueError("请选择一种支持的形状：加强角码、电子盒底座、四孔安装板、矩形板、圆柱或垫圈。")
    kind, label = matches[0]
    if kind in {"rectangle", "cylinder"} and re.search(r"通孔|带孔|开孔|打孔|孔径", text):
        raise ValueError("带通孔的零件请选择四孔安装板或垫圈模板。")
    values = {}

    def add(key, raw, name, source="user_declared"):
        values[key] = {"value": dimension(raw, name), "source": source}

    def add_choice(key, matches, default, choices, label):
        selected = {choices.get(choice) for choice in matches}
        if None in selected or len(selected) > 1:
            options = "、".join(str(option) for option in choices)
            raise ValueError(f"{label}请选择其中一个值（{options}）。")
        values[key] = {"value": next(iter(selected), default),
                       "source": "user_declared" if matches else "template_default"}

    def add_count(key, pattern, default, choices, label):
        counts = [float(raw) if re.fullmatch(NUMBER, raw) else EAST_ASIAN_COUNTS.get(raw)
                  for raw in re.findall(pattern, text)]
        add_choice(key, counts, default, {option: option for option in choices}, label)

    height = labeled(text, r"厚(?:度)?|高(?:度)?|thickness\b|height\b")
    if kind in STRUCTURES:
        triple = TRIPLE.search(text)
        dimensions = (
            ("length", r"[长長](?:度)?|length\b", "长度"),
            ("width", r"[宽寬](?:度)?|width\b", "宽度"),
            ("height", r"高(?:度)?|height\b", "高度"),
        )
        for index, (key, pattern, label_name) in enumerate(dimensions, 1):
            explicit = labeled(text, pattern)
            add(key, explicit if explicit is not None else triple[index] if triple else None, label_name)
        add("thickness", labeled(text, r"(?:壁|板)?厚(?:度)?|thickness\b"), "壁厚")
        if kind == "electronics_tray":
            post_diameter = labeled(text, r"螺[丝絲]柱(?:外|直)?[径徑]|柱[径徑]|post diameter\b")
            add("post_diameter", post_diameter or 7, "螺丝柱直径", "user_declared" if post_diameter else "template_default")
        hole_diameter = labeled(text, r"孔(?:直)?[径徑]|(?:ø|φ)\s*|hole diameter\b")
        default_hole = 5 if kind == "reinforced_bracket" else 2.8
        add("hole_diameter", hole_diameter or default_hole, "孔径", "user_declared" if hole_diameter else "template_default")
        if kind == "reinforced_bracket":
            add_count("rib_count", rf"加[强強]筋\s*[:=]?\s*{COUNT}\s*[条條]", 1, (0, 1, 2), "加强筋数量")
            add_count("base_hole_count", rf"底板\s*[:=]?\s*{COUNT}\s*(?:[个個]\s*)?孔", 2, (0, 2, 4), "底板孔数量")
            add_count("upright_hole_count", rf"[立竖豎]板\s*[:=]?\s*{COUNT}\s*(?:[个個]\s*)?孔", 2, (0, 2, 4), "立板孔数量")
        else:
            add_count("compartment_count", rf"{COUNT}\s*[仓倉]", 1, (1, 2, 3), "仓数")
            add_count("post_count", rf"{COUNT}\s*[个個根]\s*螺[丝絲]柱", 4, (0, 4), "螺丝柱数量")
            notch_states = {"开启": 1, "開啟": 1, "打开": 1, "打開": 1, "关闭": 0, "關閉": 0, "1": 1, "0": 0}
            state_pattern = "|".join(option for option in notch_states if not option.isdigit())
            notch_options = re.findall(rf"出[线線]口\s*[:=]?\s*({state_pattern}|{NUMBER})", text)
            notch_options.extend(
                "0" if prefix in {"不带", "不帶", "无", "無"} else "1"
                for prefix in re.findall(r"(不[带帶]|[无無有带帶])\s*出[线線]口", text)
            )
            add_choice("cable_notch", notch_options, 0, notch_states, "出线口状态")
        STRUCTURES[kind](**{key: item["value"] for key, item in values.items()}).validate()
    elif kind in ("rectangle", "four_hole_plate"):
        triple = TRIPLE.search(text)
        length = labeled(text, r"长(?:度)?|length\b")
        width = labeled(text, r"宽(?:度)?|width\b")
        add("length", length if length is not None else triple[1] if triple else None, "长度")
        add("width", width if width is not None else triple[2] if triple else None, "宽度")
        add("thickness", height if height is not None else triple[3] if triple else None, "厚度")
        if kind == "four_hole_plate":
            requested_counts = re.findall(
                r"([\d一二三四五六七八九十两]+)\s*(?:个|只)?\s*(?:通|安装)?孔(?![径距])", text,
            )
            if any(count not in {"4", "四"} for count in requested_counts):
                raise ValueError("安装板模板需要四个通孔。")
            diameter = labeled(text, r"孔(?:直)?径|(?:ø|φ)\s*|hole diameter\b")
            add("hole_diameter", diameter or 4, "孔径", "user_declared" if diameter else "template_default")
            spacing = re.search(rf"孔(?:中心)?距\s*[:=]?\s*({NUMBER}){MM}{TIMES}({NUMBER}){MM}", text, re.I)
            for index, key, edge, direction in (
                (1, "x_spacing", "length", r"(?:横向|x\s*)孔(?:中心)?距"),
                (2, "y_spacing", "width", r"(?:纵向|y\s*)孔(?:中心)?距"),
            ):
                if (span := labeled(text, direction)) is None and spacing:
                    span = spacing[index]
                add(key, span or 0.75 * values[edge]["value"], "孔距",
                    "user_declared" if span else "template_default")
    else:
        add("diameter", labeled(text, r"外(?:直)?径|(?<![内孔外])直径|(?:ø|φ)\s*|outer diameter\b|diameter\b"), "外径")
        add("thickness", height, "厚度或高度")
        if kind == "washer":
            add("inner_diameter", labeled(text, r"内(?:直)?径|孔(?:直)?径|inner diameter\b"), "内径")
            if values["inner_diameter"]["value"] >= values["diameter"]["value"]:
                raise ValueError("垫圈的内径须小于外径。")

    return {
        "schema_version": 1, "kind": kind, "name": label, "unit": "mm",
        "reference_text": description, "parameters": values,
    }


def build_cad(spec, output):
    import build123d as cad
    import trimesh

    sys.path.insert(0, str(ROOT / "cad-worker"))
    from build_plate import Plate, construct, require_dimensions, verify_step

    kind = spec["kind"]
    params = {name: item["value"] for name, item in spec["parameters"].items()}
    thickness = params["thickness"]
    alignment = (cad.Align.CENTER, cad.Align.CENTER, cad.Align.MIN)
    plate = None
    structure = None
    if kind in STRUCTURES:
        structure = STRUCTURES[kind](**params)
        solid = structure.solid()
        expected = (params["length"], params["width"], params["height"])
    elif kind == "four_hole_plate":
        plate = Plate(**params)
        hole = plate.hole_diameter
        if hole >= min(plate.x_spacing, plate.y_spacing) or any((
            plate.x_spacing + hole >= plate.length, plate.y_spacing + hole >= plate.width,
        )):
            raise ValueError("孔距和孔径会造成孔相交或超出板边缘。请调整尺寸。")
        solid = construct(plate)
        expected = plate.dimensions
    elif kind == "rectangle":
        expected = (params["length"], params["width"], thickness)
        solid = cad.Box(*expected, align=alignment)
    else:
        diameter = params["diameter"]
        expected = (diameter, diameter, thickness)
        solid = cad.Cylinder(diameter / 2, thickness, align=alignment)
        if kind == "washer":
            bore = cad.Pos(0, 0, -1) * cad.Cylinder(params["inner_diameter"] / 2, thickness + 2, align=alignment)
            solid = solid - bore

    if not solid.is_valid or len(solid.solids()) != 1 or solid.volume <= 0:
        raise ValueError("建模所得几何无法形成有效的单一实体。")
    require_dimensions(tuple(solid.bounding_box().size), expected)
    solid.label = kind
    solid.color = cad.Color(0.20, 0.65, 0.48)

    if output.exists():
        raise FileExistsError("模型输出目录已存在。")
    with TemporaryDirectory(prefix=".text-model-", dir=output.parent) as temporary:
        work = Path(temporary) / "result"
        work.mkdir()
        step, stl, glb = (work / f"model.{ext}" for ext in ("step", "stl", "glb"))
        if not all((
            cad.export_step(solid, step, timestamp="2000-01-01T00:00:00Z"),
            cad.export_stl(solid, stl, tolerance=0.002, angular_tolerance=0.05),
            cad.export_gltf(solid, glb, binary=True, linear_deflection=0.002, angular_deflection=0.05),
        )):
            raise ValueError("已生成实体，模型文件导出失败。")

        step_check = verify_step(step, plate) if plate else None
        features = None
        if step_check is None:
            restored = cad.import_step(step)
            dimensions = tuple(restored.bounding_box().size)
            require_dimensions(dimensions, expected)
            if (not restored.is_valid or len(restored.solids()) != 1
                    or not math.isclose(solid.volume, restored.volume, rel_tol=0.00001)):
                raise ValueError("STEP 回读未通过。")
            step_check = {"dimensions_mm_xyz": dimensions, "solid_count": 1, "volume_mm3": restored.volume}
            if structure is not None:
                features = structure.verify(restored.solids()[0])
                step_check["features"] = features

        def check_mesh(path):
            mesh = trimesh.load_scene(path).to_mesh()
            if path.suffix == ".glb":
                mesh.apply_scale(1000)
                mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, (1, 0, 0)))
            mesh.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=5)
            dims = tuple(float(value) for value in mesh.extents)
            require_dimensions(dims, expected, tolerance=0.04)
            if not mesh.is_volume or mesh.body_count != 1 or not math.isclose(solid.volume, mesh.volume, rel_tol=0.005):
                raise ValueError(f"{path.suffix} 网格与工程实体的复核不一致。")
            return {
                "dimensions_mm_xyz": dims, "watertight": bool(mesh.is_watertight),
                "winding_consistent": bool(mesh.is_winding_consistent), "connected_components": 1,
                "volume_mm3": float(mesh.volume), "triangles": len(mesh.faces),
            }

        files = {}
        for path, checks in ((step, step_check), (stl, check_mesh(stl)), (glb, check_mesh(glb))):
            data = path.read_bytes()
            files[path.suffix[1:]] = {
                "file": path.name, "bytes": len(data), "sha256": sha256(data).hexdigest(), "checks": checks,
            }
        report = {
            "status": "verified", "mode": "local_text_cad", "geometry_type": "BRep",
            "editability": "parametric", "name": spec["name"], "kind": kind, "parameters": spec["parameters"],
            "dimensions_source": "cad-spec.json", "assets": files,
        }
        if features is not None:
            report["features"] = features
        for filename, data in (("cad-spec.json", spec), ("verification.json", report)):
            (work / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        work.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        description = args.input.read_text(encoding="utf-8")
        build_cad(read_spec(description), args.out)
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()

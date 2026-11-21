"""Offline geometry screening for immutable model revisions and a slicer profile."""

import argparse
from hashlib import sha256
from io import BytesIO
from itertools import combinations
import json
import math
from pathlib import Path

import numpy as np
import trimesh


MAX_STL_BYTES = 32 * 1024 * 1024
MAX_LIGAMENT_PAIRS = 3_000_000
MAX_COORDINATE_MM = 1e8
COORD_TOLERANCE_MM = 1e-6
REFERENCE_RULES = (
    ("self_intersection", "网格自交与实体重叠", "未运行网格自交检测。封闭拓扑检查只统计边的连接关系。"),
    ("global_wall_thickness", "全局最小壁厚", "未逐点测量任意墙体、同轮廓的细颈和曲面厚度。"),
    ("supports", "悬垂、支撑与附着", "未计算悬垂、底板附着或支撑、裙边及底座占用。"),
    ("tolerances", "收缩与公差", "未测量材料收缩、装配间隙、细孔可打印性或真机尺寸偏差。"),
    ("target_printer", "实体设备兼容性", "此报告仅使用切片配置做几何筛查，实体设备兼容性待验证。"),
)


def _check(check_id: str, label: str, status: str, detail: str, **measurements) -> dict:
    return dict(id=check_id, label=label, status=status, detail=detail, **measurements)


def _read_profile(path: Path) -> tuple[dict, str]:
    raw = path.read_bytes()
    profile = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(profile, dict) or not isinstance(profile.get("id"), str) or not profile["id"].strip():
        raise ValueError("切片配置缺少有效的 id。")
    params = profile.get("params")
    if not isinstance(params, dict):
        raise ValueError("切片配置缺少 params。")
    for name in ("bed_width", "bed_depth", "printable_height", "layer_height", "first_layer_height", "line_width", "nozzle_diameter"):
        value = params.get(name)
        if type(value) not in (int, float) or not 0 < value <= 10_000:
            raise ValueError(f"切片配置需要有效的正数 {name}（毫米）。")
    wall_loops = params.get("wall_loops")
    if type(wall_loops) is not int or not 0 <= wall_loops <= 100:
        raise ValueError("切片配置需要 0 至 100 之间的整数 wall_loops。")
    return profile, sha256(raw).hexdigest()


def _recorded_hash(model_dir: Path) -> str | None:
    try:
        manifest = json.loads((model_dir / "verification.json").read_text(encoding="utf-8-sig"))
        manifest_hash = manifest["assets"]["stl"]["sha256"]
    except (OSError, UnicodeError, ValueError, KeyError, TypeError):
        return None
    return manifest_hash if isinstance(manifest_hash, str) else None


def _flat_top_faces(mesh: trimesh.Trimesh) -> np.ndarray | None:
    """Find upper cap faces when the STL is a vertical two-plane extrusion."""
    z = mesh.vertices[:, 2]
    base = np.abs(z - z.min()) <= COORD_TOLERANCE_MM
    top = np.abs(z - z.max()) <= COORD_TOLERANCE_MM
    if np.any(base & top) or not np.all(base | top):
        return None

    top_faces = np.all(top[mesh.faces], axis=1)
    base_faces = np.all(base[mesh.faces], axis=1)
    if not np.any(top_faces) or not np.any(base_faces):
        return None
    side_normals = mesh.face_normals[~(top_faces | base_faces)]
    if not len(side_normals) or np.any(np.abs(side_normals[:, 2]) > COORD_TOLERANCE_MM):
        return None
    return mesh.faces[top_faces]


def _footprint_loops(mesh: trimesh.Trimesh, cap: np.ndarray) -> list[np.ndarray] | None:
    cap_edges = np.concatenate((cap[:, [0, 1]], cap[:, [1, 2]], cap[:, [2, 0]]))
    edges, incidence = np.unique(np.sort(cap_edges, axis=1), axis=0, return_counts=True)
    boundary = edges[incidence == 1]
    vertices, degrees = np.unique(boundary, return_counts=True)
    if not len(vertices) or np.any(degrees != 2):
        return None
    segments = mesh.vertices[boundary, :2]
    if np.any(np.all(segments[:, 0, :] == segments[:, 1, :], axis=1)):
        return None
    components = trimesh.graph.connected_components(boundary, nodes=vertices)
    counts = [len(component) for component in components]
    total_pairs = (int(sum(counts)) ** 2 - sum(count * count for count in counts)) // 2
    if total_pairs > MAX_LIGAMENT_PAIRS:
        return None
    return [segments[np.isin(boundary[:, 0], component)] for component in components]


def _point_segment_dist_sq(points: np.ndarray, start: np.ndarray, end: np.ndarray) -> np.ndarray:
    direction = end - start
    offset = points - start
    scale = np.clip(np.sum(offset * direction, axis=-1, keepdims=True) / np.sum(direction ** 2, axis=-1, keepdims=True), 0, 1)
    return np.sum((offset - scale * direction) ** 2, axis=-1)


def _cross(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


def _loop_gap(first: np.ndarray, second: np.ndarray) -> float:
    """Minimum segment separation between two boundary loops, including crossings."""
    gap_sq = math.inf
    batch_size = max(1, 131_072 // len(second))
    right_a = second[None, :, 0, :]
    right_b = second[None, :, 1, :]
    for offset in range(0, len(first), batch_size):
        batch = first[offset:offset + batch_size]
        left_a = batch[:, None, 0, :]
        left_b = batch[:, None, 1, :]
        span_left = left_b - left_a
        span_right = right_b - right_a
        first_side = _cross(span_left, right_a - left_a) * _cross(span_left, right_b - left_a)
        second_side = _cross(span_right, left_a - right_a) * _cross(span_right, left_b - right_a)
        if np.any((first_side < 0) & (second_side < 0)):
            return 0.0
        for point, start, end in (
            (left_a, right_a, right_b), (left_b, right_a, right_b),
            (right_a, left_a, left_b), (right_b, left_a, left_b),
        ):
            gap_sq = min(gap_sq, float(np.min(_point_segment_dist_sq(point, start, end))))
    return math.sqrt(gap_sq)


def _check_planar_features(mesh: trimesh.Trimesh, params: dict, dims: list[float]) -> list[dict]:
    width_floor = max(params["line_width"], params["nozzle_diameter"])
    width = min(dims[:2])
    checks = [_check(
        "xy_span", "整体 XY 尺寸与单线宽度", "fail" if width + COORD_TOLERANCE_MM < width_floor else "pass",
        "使用模型包围盒的较短 XY 边进行筛查。", measured_mm=width, minimum_mm=width_floor,
    )]

    cap = _flat_top_faces(mesh)
    layer_floor = params["first_layer_height"]
    too_short = dims[2] + COORD_TOLERANCE_MM < layer_floor
    if cap is None:
        return checks + [
            _check("z_span", "整体 Z 尺寸与首层厚度", "fail" if too_short else "pass",
                   "比较模型的整体 Z 尺寸和配置的首层厚度。", measured_mm=dims[2], minimum_mm=layer_floor),
            _check("extrusion_height", "平板厚度", "not_checked", "未确认可用的 Z 轴双平面拉伸轮廓。"),
            _check("planar_ligament", "轮廓间的最小间距", "not_checked", "未确认可用的平面轮廓。"),
            _check("planar_scope", "平板规则适用性", "warn", "平板规则测量未完成，需要另行核对细小特征。"),
        ]

    checks.append(_check(
        "extrusion_height", "平板厚度", "fail" if too_short else "pass",
        "测量 STL 上下两平面之间的距离，并与切片首层厚度比较。", measured_mm=dims[2], minimum_mm=layer_floor,
    ))
    loops = _footprint_loops(mesh, cap)
    if loops is None:
        return checks + [_check("planar_ligament", "轮廓间的最小间距", "warn", "平面边界无法解析或超出计算上限，间距未测量。")]
    if len(loops) < 2:
        return checks + [_check("planar_ligament", "轮廓间的最小间距", "not_checked", "截面只有一个边界环，未测量同一轮廓两侧的局部间距。")]

    measured = min(_loop_gap(a, b) for a, b in combinations(loops, 2))
    target = max(width_floor, params["wall_loops"] * params["line_width"])
    if measured + COORD_TOLERANCE_MM < width_floor:
        status = "fail"
    else:
        status = "warn" if measured + COORD_TOLERANCE_MM < target else "pass"
    return checks + [_check(
        "planar_ligament", "轮廓间的最小间距", status,
        "测量 STL 平面外边界与孔边、以及孔边之间的最短面内距离。两条边界之间的空间需容纳所设线宽。",
        measured_mm=measured, minimum_mm=width_floor, wall_line_target_mm=target, boundary_loops=len(loops),
    )]


def _mesh_checks(raw: bytes, profile: dict, checks: list[dict]) -> dict:
    try:
        mesh = trimesh.load_mesh(BytesIO(raw), file_type="stl", process=False)
    except (ValueError, TypeError, OverflowError, IndexError, OSError):
        checks.append(_check("finite_mesh", "可读网格与有效坐标", "fail", "无法解析 STL。"))
        return {}
    finite = len(mesh.faces) > 0 and bool(np.isfinite(mesh.vertices).all())
    checks.append(_check("finite_mesh", "可读网格与有效坐标", "pass" if finite else "fail", "网格至少需要一个三角形，所有顶点坐标需为有限数值。"))
    if not finite:
        return {}
    if np.max(np.abs(mesh.vertices)) > MAX_COORDINATE_MM:
        checks.append(_check("coordinate_range", "网格坐标范围", "fail", "网格坐标超出本地几何计算范围。"))
        return {}

    # STL does not store shared vertex indices. Weld coincident vertices without repairing faces.
    mesh.merge_vertices(digits_vertex=8)
    valid_faces = mesh.nondegenerate_faces()
    invalid_count = int(np.count_nonzero(~valid_faces))
    checks.append(_check("degenerate_faces", "退化三角面", "fail" if invalid_count else "pass", "统计塌缩到点或线的面片。", count=invalid_count))
    watertight = mesh.is_watertight
    winding = mesh.is_winding_consistent
    checks.extend([
        _check("watertight", "网格封闭性", "pass" if watertight else "fail", "每条边需要连接两个三角面。"),
        _check("winding", "网格面朝向", "pass" if winding else "fail", "相邻三角面需要以相反方向共享一条边。"),
    ])

    components = trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(mesh.faces)))
    count = len(components)
    checks.append(_check("components", "相连实体", "pass" if count == 1 else "fail", "当前工作台要求每个 STL 有一个相连的实体外壳。", count=count))
    dims = [float(value) for value in mesh.extents]
    geometry = {"dimensions_mm": dims, "triangles": len(mesh.faces), "connected_components": count}
    if watertight and winding and not invalid_count:
        relative = mesh.triangles - mesh.bounds.mean(axis=0)
        a, b, c = relative.transpose(1, 0, 2)
        facets = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0
        volumes = [float(np.sum(facets[indices])) for indices in components]
        geometry["volume_mm3"] = math.fsum(volumes)
        checks.append(_check("positive_volumes", "各相连网格的有向体积", "pass" if all(math.isfinite(v) and v > 0 for v in volumes) else "fail", "封闭网格的每个外壳都需要有正体积和向外的法线。", minimum_mm3=min(volumes)))
    else:
        checks.append(_check("positive_volumes", "各相连网格的有向体积", "not_checked", "封闭性、绕向或面片完整性未通过。"))

    params = profile["params"]
    limits = [float(params[key]) for key in ("bed_width", "bed_depth", "printable_height")]
    exceeds = [axis for axis, dim, limit in zip("XYZ", dims, limits) if dim > limit + COORD_TOLERANCE_MM]
    checks.append(_check("bed_envelope", "模型幅面", "fail" if exceeds else "pass", "按 STL 当前方向检查模型包围盒，Z 轴以模型底面贴床计算。", measured_mm=dims, limits_mm=limits, exceeds=exceeds))
    if watertight and winding and count == 1 and not invalid_count:
        checks.extend(_check_planar_features(mesh, params, dims))
    return geometry


def assess(model_dir: Path, profile_path: Path) -> dict:
    model_dir, profile_path = Path(model_dir), Path(profile_path)
    profile, profile_hash = _read_profile(profile_path)
    checks: list[dict] = []
    geometry = {}
    model_hash = None
    try:
        with (model_dir / "model.stl").open("rb") as stream:
            raw = stream.read(MAX_STL_BYTES + 1)
    except OSError:
        checks.append(_check("stl_source", "STL 文件", "fail", "当前版本缺少可读的 model.stl。"))
    else:
        if len(raw) > MAX_STL_BYTES:
            checks.append(_check("stl_source", "STL 文件", "fail", "STL 超出本地检查的 32 MiB 上限。"))
        else:
            model_hash = sha256(raw).hexdigest()
            recorded = _recorded_hash(model_dir)
            matches = recorded == model_hash
            checks.append(_check("stl_identity", "STL 版本完整性", "pass" if matches else "fail", "用实际 STL 文件的 SHA-256 核对当前版本清单。", manifest_sha256=recorded))
            geometry = _mesh_checks(raw, profile, checks)

    checks.extend(_check(key, label, "not_checked", detail) for key, label, detail in REFERENCE_RULES)
    statuses = {check["status"] for check in checks}
    status = "blocked" if "fail" in statuses else "warn" if "warn" in statuses else "pass"
    return {
        "schema_version": 1,
        "status": status,
        "can_slice": status != "blocked",
        "model_sha256": model_hash,
        "profile_sha256": profile_hash,
        "profile_id": profile["id"],
        "profile_applicability": profile.get("applicability"),
        "geometry": geometry,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("model", "profile", "out"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = assess(args.model, args.profile)
        with args.out.open("x", encoding="utf-8") as output:
            output.write(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, f"DFM: {error}\n")
    return 2 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())

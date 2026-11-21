"""Build and independently re-open the G0 four-hole plate assets."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from importlib.metadata import version
import json
import math
from pathlib import Path
import platform
from tempfile import TemporaryDirectory


@dataclass(frozen=True)
class Plate:
    length: float
    width: float
    thickness: float
    hole_diameter: float
    x_spacing: float
    y_spacing: float

    @classmethod
    def from_spec(cls, spec):
        schema_version = spec["schema_version"]
        if type(schema_version) is not int or (schema_version, spec["kind"], spec["unit"]) != (
            1, "four_hole_plate", "mm",
        ):
            raise ValueError("Expected schema v1, kind four_hole_plate and millimeters")
        parameters = spec["parameters"]
        if set(parameters) != set(cls.__annotations__):
            raise ValueError("Provide exactly the six plate parameters with their sources")
        values = {}
        for name, entry in parameters.items():
            value = entry["value"]
            if type(value) not in (int, float) or not 0.1 <= value <= 1000:
                raise ValueError(f"{name} must be a number between 0.1 and 1000 mm")
            if entry["source"] not in {"requirements", "fixture_assumption", "user_declared"}:
                raise ValueError(f"{name} must have a recognized dimension source")
            values[name] = float(value)

        plate = cls(**values)
        diameter = plate.hole_diameter
        if (
            diameter >= min(plate.x_spacing, plate.y_spacing)
            or plate.x_spacing + diameter >= plate.length
            or plate.y_spacing + diameter >= plate.width
        ):
            raise ValueError("Hole circles must be disjoint and strictly inside the plate")
        return plate

    @property
    def dimensions(self):
        return (self.length, self.width, self.thickness)

    @property
    def centers(self):
        return sorted(
            (x * self.x_spacing / 2, y * self.y_spacing / 2)
            for x in (-1, 1)
            for y in (-1, 1)
        )

    @property
    def volume(self):
        return self.thickness * (self.length * self.width - math.pi * self.hole_diameter**2)


def construct(plate):
    import build123d as cad

    alignment = (cad.Align.CENTER, cad.Align.CENTER, cad.Align.MIN)
    body = cad.Box(*plate.dimensions, align=alignment)
    for x, y in plate.centers:
        bore = cad.Pos(x, y, -1) * cad.Cylinder(
            plate.hole_diameter / 2, plate.thickness + 2, align=alignment,
        )
        body -= bore
    if not body.is_valid or len(body.solids()) != 1:
        raise ValueError("CAD operations did not produce one valid solid")
    body.label = "Four-hole mounting plate"
    body.color = cad.Color(0.10, 0.55, 0.61)
    return body


def require_dimensions(actual, expected, tolerance=0.001):
    if not all(math.isclose(a, b, abs_tol=tolerance) for a, b in zip(actual, expected, strict=True)):
        raise ValueError(f"Unexpected dimensions {actual}, expected {expected}")


def verify_step(path, plate):
    import build123d as cad
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    solid = cad.import_step(path)
    if not solid.is_valid or len(solid.solids()) != 1:
        raise ValueError("STEP round trip did not produce one valid solid")
    dimensions = tuple(solid.bounding_box().size)
    require_dimensions(dimensions, plate.dimensions)
    if not math.isclose(solid.volume, plate.volume, rel_tol=0.00001):
        raise ValueError("STEP volume does not match the plate with four through-holes")

    holes = []
    for face in solid.faces().filter_by(cad.GeomType.CYLINDER):
        cylinder = BRepAdaptor_Surface(face.wrapped).Cylinder()
        center = cylinder.Location()
        axis = cylinder.Axis().Direction()
        if not math.isclose(abs(axis.Z()), 1, abs_tol=0.00001):
            raise ValueError("STEP cylindrical face is not perpendicular to the plate")
        holes.append((center.X(), center.Y(), cylinder.Radius() * 2, face.bounding_box().size.Z))
    holes.sort()
    if len(holes) != 4:
        raise ValueError(f"STEP round trip has {len(holes)} cylindrical walls, expected 4")
    for hole, center in zip(holes, plate.centers, strict=True):
        require_dimensions(hole, (*center, plate.hole_diameter, plate.thickness))
    return {
        "dimensions_mm_xyz": dimensions,
        "solid_count": 1,
        "volume_mm3": solid.volume,
        "through_holes_xy_diameter_depth_mm": holes,
    }


def verify_mesh(path, plate, *, glb=False):
    import trimesh

    mesh = trimesh.load_scene(path).to_mesh()
    if glb:
        # glTF world positions use meters and +Y up. Convert to CAD using +Z up.
        mesh.apply_scale(1000)
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    dimensions = tuple(float(value) for value in mesh.extents)
    require_dimensions(dimensions, plate.dimensions)
    if not mesh.is_volume or mesh.body_count != 1:
        raise ValueError(f"{path.suffix}: expected one watertight, consistently oriented volume")
    if not math.isclose(mesh.volume, plate.volume, rel_tol=0.005):
        raise ValueError(f"{path.suffix}: mesh volume differs from the design")
    return {
        "dimensions_mm_xyz": dimensions,
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "connected_components": mesh.body_count,
        "triangles": len(mesh.faces),
        "volume_mm3": float(mesh.volume),
    }


def build_assets(spec_path, output):
    spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    plate = Plate.from_spec(spec)
    if output.exists():
        raise FileExistsError(f"Choose a new output directory: {output}")

    import build123d as cad

    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="cad-", dir=output.parent) as temporary:
        work = Path(temporary) / "result"
        work.mkdir()
        paths = {ext: work / f"model.{ext}" for ext in ["step", "stl", "glb"]}
        solid = construct(plate)
        # Freeze the STEP metadata timestamp so it does not affect comparisons.
        written = [
            cad.export_step(solid, paths["step"], timestamp="2000-01-01T00:00:00Z"),
            cad.export_stl(solid, paths["stl"], tolerance=0.02),
            cad.export_gltf(solid, paths["glb"], binary=True, linear_deflection=0.02),
        ]
        if not all(written):
            raise ValueError("At least one CAD export failed")
        checks = {
            "step": verify_step(paths["step"], plate),
            "stl": verify_mesh(paths["stl"], plate),
            "glb": verify_mesh(paths["glb"], plate, glb=True),
        }
        files = {
            ext: {
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path.read_bytes()).hexdigest(),
                "checks": checks[ext],
            }
            for ext, path in paths.items()
        }
        report = {
            "status": "verified",
            "checked_at_utc": datetime.now(timezone.utc).isoformat(),
            "mode": "G0_local_fixture",
            "geometry_type": "BRep",
            "editability": "parametric",
            "dimensions_source": "cad-spec.json",
            "expected_volume_mm3": plate.volume,
            "builder": {
                "script_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
                "python": platform.python_version(),
                "build123d": version("build123d"),
                "cadquery-ocp-novtk": version("cadquery-ocp-novtk"),
                "trimesh": version("trimesh"),
            },
            "assets": files,
        }
        (work / "cad-spec.json").write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (work / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        work.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        build_assets(args.spec, args.out)
    except (ValueError, OSError, KeyError, TypeError, RuntimeError) as error:
        parser.exit(1, f"CAD verification failed: {error}\n")
    print(f"Verified STEP, STL and GLB: {args.out.absolute()}")


if __name__ == "__main__":
    main()

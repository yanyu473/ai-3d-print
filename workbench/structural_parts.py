"""Solid CAD and STEP feature checks for assemblies' individual parts."""

from dataclasses import dataclass
from itertools import combinations, product, zip_longest
import math


@dataclass(frozen=True)
class ReinforcedBracket:
    length: float
    width: float
    height: float
    thickness: float
    hole_diameter: float
    rib_count: int = 1
    base_hole_count: int = 2
    upright_hole_count: int = 2

    def validate(self):
        if self.rib_count not in (0, 1, 2) or any(
            count not in (0, 2, 4) for count in (self.base_hole_count, self.upright_hole_count)
        ):
            raise ValueError("加强筋支持 0、1、2 条，两块安装板分别支持 0、2、4 孔。")
        if min(self.length, self.width, self.height) <= 3 * self.thickness:
            raise ValueError("加强角码的长、宽和高须大于三倍壁厚。")
        if self.rib_count == 2 and self.length <= 4 * self.thickness:
            raise ValueError("双筋角码的长度须大于四倍壁厚，以留出两筋之间的间距。")
        radius = self.hole_diameter / 2
        for holes, lower, upper in (
            (self.base_holes, -self.width / 2, self.upright_inner),
            (self.upright_holes, self.thickness, self.height),
        ):
            for x, row in holes:
                clearance = min(self.length / 2 - abs(x), row - lower, upper - row)
                if self.rib_centers:
                    clearance = min(clearance, *(abs(x - rib_x) - self.thickness / 2 for rib_x in self.rib_centers))
                if radius >= clearance:
                    raise ValueError("安装孔与板边、折角或加强筋相交，请缩小孔径或调整布局。")
            if any(math.dist(*pair) <= 2 * radius for pair in combinations(holes, 2)):
                raise ValueError("同一面的安装孔相交，请缩小孔径或减少孔位。")

    @property
    def upright_inner(self):
        return self.width / 2 - self.thickness

    @property
    def base_holes(self):
        rows = {0: (), 2: (-0.25,), 4: (-0.30, -0.02)}[self.base_hole_count]
        return tuple(product((-self.length / 4, self.length / 4), (row * self.width for row in rows)))

    @property
    def upright_holes(self):
        rows = {0: (), 2: (0.65,), 4: (0.38, 0.73)}[self.upright_hole_count]
        return tuple(product((-self.length / 4, self.length / 4), (row * self.height for row in rows)))

    @property
    def rib_centers(self):
        return {0: (), 1: (0,), 2: (-self.length / 8, self.length / 8)}[self.rib_count]

    @property
    def rib_points(self):
        root_z = 0.70 * self.thickness
        return (
            (-0.30 * self.width, root_z),
            (self.width / 2 - self.thickness / 2, root_z),
            (self.width / 2 - self.thickness / 2, 0.83 * self.height),
        )

    def solid(self):
        import build123d as cad

        self.validate()
        length, width, height, thickness = self.length, self.width, self.height, self.thickness
        alignment = (cad.Align.CENTER, cad.Align.CENTER, cad.Align.MIN)
        base = cad.Box(length, width, thickness, align=alignment)
        upright = cad.Pos(0, width / 2 - thickness / 2, 0) * cad.Box(length, thickness, height, align=alignment)
        bracket = base + upright
        if self.rib_centers:
            triangle = cad.Plane.YZ * cad.Polygon(*self.rib_points, align=None)
            rib = cad.extrude(triangle, amount=thickness, dir=(1, 0, 0))
            for center in self.rib_centers:
                bracket += cad.Pos(center - thickness / 2, 0, 0) * rib

        if self.base_holes or self.upright_holes:
            cutter = cad.Cylinder(self.hole_diameter / 2, thickness + 2, align=alignment)
            vertical_face_cutter = cad.Rot(-90, 0, 0) * cutter
            for base_hole, upright_hole in zip_longest(self.base_holes, self.upright_holes):
                if base_hole is not None:
                    x, y = base_hole
                    bracket -= cad.Pos(x, y, -1) * cutter
                if upright_hole is not None:
                    x, z = upright_hole
                    bracket -= cad.Pos(x, self.upright_inner - 1, z) * vertical_face_cutter
        return bracket

    def verify(self, solid):
        plate_t = self.thickness
        hole_r = self.hole_diameter / 2
        outward_rim = hole_r + (self.length / 4 - hole_r) / 2
        for x, y in self.base_holes:
            rim_x = x + math.copysign(outward_rim, x)
            for fraction in (0.20, 0.80):
                z = plate_t * fraction
                require_opening(solid, (x, y, z), (rim_x, y, z), "角码底板安装孔")
        for x, z in self.upright_holes:
            rim_x = x + math.copysign(outward_rim, x)
            for fraction in (0.20, 0.80):
                y = self.upright_inner + plate_t * fraction
                require_opening(solid, (x, y, z), (rim_x, y, z), "角码竖板安装孔")
        (tip_y, root_z), (attach_y, _), (_, peak_z) = self.rib_points
        rib_y = tip_y + (self.upright_inner - tip_y) * 0.78
        edge_z = root_z + (peak_z - root_z) * (rib_y - tip_y) / (attach_y - tip_y)
        rib_z = (plate_t + edge_z) / 2
        gap_x = 0 if self.rib_count == 2 else self.length / 4
        for rib_x in self.rib_centers:
            require_opening(solid, (gap_x, rib_y, rib_z), (rib_x, rib_y, rib_z), "角码三角加强筋")
        if not self.rib_centers:
            require_opening(solid, (0, rib_y, rib_z), (0, rib_y, plate_t / 2), "角码开放内角")
        verify_bores(solid, self.hole_diameter, {
            (0, 0, 1): self.base_hole_count, (0, 1, 0): self.upright_hole_count,
        })
        return {
            "base_holes": {"count": self.base_hole_count, "axis": "Z", "diameter_mm": self.hole_diameter,
                           "centers_xy_mm": self.base_holes},
            "upright_holes": {"count": self.upright_hole_count, "axis": "Y", "diameter_mm": self.hole_diameter,
                              "centers_xz_mm": self.upright_holes},
            "gussets": {"count": self.rib_count, "thickness_mm": plate_t, "centers_x_mm": self.rib_centers},
        }


@dataclass(frozen=True)
class ElectronicsTray:
    length: float
    width: float
    height: float
    thickness: float
    post_diameter: float
    hole_diameter: float
    compartment_count: int = 1
    post_count: int = 4
    cable_notch: int = 0

    def validate(self):
        if self.compartment_count not in (1, 2, 3) or self.post_count not in (0, 4) or self.cable_notch not in (0, 1):
            raise ValueError("电子盒支持 1、2、3 仓和 0、4 根螺丝柱，出线口可开启或关闭。")
        if self.height <= 3 * self.thickness:
            raise ValueError("电子盒的高度须大于三倍壁厚，以留出内腔。")
        if min(self.length, self.width) <= 2.4 * self.thickness:
            raise ValueError("电子盒的底面太小，请放大底面或减小壁厚。")
        if self.compartment_count > 1 and self.compartment_pitch <= self.thickness:
            raise ValueError("分仓宽度不足以容纳隔板，请减少仓数或加长盒体。")
        if self.cable_notch and self.compartment_pitch <= self.thickness:
            raise ValueError("出线口所在仓太窄，请加长盒体或减少仓数。")
        if self.post_count:
            if min(self.length, self.width) <= 3 * self.thickness + 2 * self.post_diameter:
                raise ValueError("电子盒的内腔不足以容纳四根独立螺丝柱，请调整底面尺寸、壁厚或柱径。")
            if self.hole_diameter >= self.post_diameter:
                raise ValueError("螺丝孔径须小于螺丝柱外径。")
            if any(
                abs(column_x - divider_x) <= (self.post_diameter + self.thickness) / 2
                for column_x, _ in self.post_centers for divider_x in self.divider_centers
            ):
                raise ValueError("隔板与螺丝柱相交，请减小柱径、放大盒体或减少仓数。")

    @property
    def cavity(self):
        return (self.length - 2 * self.thickness, self.width - 2 * self.thickness, self.height - self.thickness)

    @property
    def post_top(self):
        return self.thickness + 0.64 * (self.height - self.thickness)

    @property
    def pilot_bottom(self):
        return 1.35 * self.thickness

    @property
    def post_centers(self):
        if not self.post_count:
            return ()
        inset = 1.5 * self.thickness + self.post_diameter / 2
        dx, dy = self.length / 2 - inset, self.width / 2 - inset
        return tuple(product((-dx, dx), (-dy, dy)))

    @property
    def compartment_pitch(self):
        return self.cavity[0] / self.compartment_count

    @property
    def compartment_centers(self):
        return tuple(-self.cavity[0] / 2 + (index + 0.5) * self.compartment_pitch
                     for index in range(self.compartment_count))

    @property
    def divider_centers(self):
        return tuple(-self.cavity[0] / 2 + index * self.compartment_pitch
                     for index in range(1, self.compartment_count))

    @property
    def divider_top(self):
        return self.thickness + 0.82 * self.cavity[2]

    @property
    def notch_bottom(self):
        return self.thickness + 0.55 * self.cavity[2]

    @property
    def notch_width(self):
        return min(0.28 * self.cavity[0], 0.56 * self.compartment_pitch)

    @property
    def corner_radius(self):
        return 1.2 * self.thickness

    def solid(self):
        import build123d as cad

        self.validate()
        alignment = (cad.Align.CENTER, cad.Align.CENTER, cad.Align.MIN)
        outside = cad.extrude(cad.RectangleRounded(self.length, self.width, self.corner_radius), self.height)
        cavity_profile = cad.RectangleRounded(*self.cavity[:2], self.corner_radius - self.thickness)
        cavity = cad.Pos(0, 0, self.thickness) * cad.extrude(cavity_profile, self.cavity[2] + 1)
        tray = outside - cavity

        overlap_z = self.thickness * 0.80
        if self.divider_centers:
            divider = cad.Box(self.thickness, self.width - self.thickness, self.divider_top - overlap_z, align=alignment)
            for center in self.divider_centers:
                tray += cad.Pos(center, 0, overlap_z) * divider
        if self.post_centers:
            post = cad.Cylinder(self.post_diameter / 2, self.post_top - overlap_z, align=alignment)
            cutter = cad.Cylinder(self.hole_diameter / 2, self.post_top - self.pilot_bottom + 1, align=alignment)
            for x, y in self.post_centers:
                tray += cad.Pos(x, y, overlap_z) * post
                tray -= cad.Pos(x, y, self.pilot_bottom) * cutter
        if self.cable_notch:
            notch = cad.Box(self.notch_width, 1.4 * self.thickness, self.height - self.notch_bottom + 1, align=alignment)
            tray -= cad.Pos(self.compartment_centers[0], (self.thickness - self.width) / 2, self.notch_bottom) * notch
        return tray

    def verify(self, solid):
        plate_t = self.thickness
        cavity_mid_z = (plate_t + self.height) / 2
        for center in self.compartment_centers:
            require_opening(solid, (center, 0, cavity_mid_z), (center, 0, plate_t / 2), "电子盒开放分仓与底板")
        for index, center in enumerate(self.divider_centers):
            require_opening(solid, (self.compartment_centers[index], 0, cavity_mid_z), (center, 0, cavity_mid_z), "电子盒隔板")
        wall_x = (self.length - plate_t) / 2
        require_opening(solid, (self.compartment_centers[0], 0, self.height - plate_t / 4), (wall_x, 0, cavity_mid_z), "电子盒立壁")
        notch_x = self.compartment_centers[0]
        notch_y = (plate_t - self.width) / 2
        if self.cable_notch:
            require_opening(solid, (notch_x, notch_y, (self.notch_bottom + self.height) / 2),
                            (notch_x, notch_y, (self.notch_bottom + plate_t) / 2), "电子盒出线口及其下方立壁")
        else:
            require_opening(solid, (notch_x, 0, cavity_mid_z), (notch_x, notch_y, cavity_mid_z), "电子盒完整前壁")
        pilot_z = (self.post_top + self.pilot_bottom) / 2
        rim_radius = (self.post_diameter + self.hole_diameter) / 4
        for x, y in self.post_centers:
            rim_x = x - math.copysign(rim_radius, x)
            require_opening(solid, (x, y, pilot_z), (rim_x, y, pilot_z), "螺丝柱内的盲孔")
            require_opening(solid, (x, y, (self.post_top + self.height) / 2), (x, y, plate_t / 2), "螺丝柱高度与盲孔底板")
        verify_bores(solid, self.hole_diameter, {(0, 0, 1): self.post_count})
        return {
            "cavity": {"open_top": True, "dimensions_mm_xyz": self.cavity, "wall_and_floor_mm": plate_t},
            "screw_posts": {
                "count": self.post_count, "diameter_mm": self.post_diameter,
                "pilot_diameter_mm": self.hole_diameter,
                "pilot_depth_mm": self.post_top - self.pilot_bottom,
            },
            "dividers": {"count": len(self.divider_centers), "compartment_count": self.compartment_count,
                         "centers_x_mm": self.divider_centers, "top_z_mm": self.divider_top},
            "cable_notch": {"enabled": bool(self.cable_notch), "width_mm": self.notch_width if self.cable_notch else 0,
                            "bottom_z_mm": self.notch_bottom if self.cable_notch else None},
        }


def require_opening(solid, void_point, material_point, name):
    if solid.is_inside(void_point) or not solid.is_inside(material_point):
        raise ValueError(f"STEP 回读未找到完整的{name}。")


def verify_bores(solid, diameter, expected_axes):
    from build123d import GeomType
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    counts = dict.fromkeys(expected_axes, 0)
    for face in solid.faces():
        if face.geom_type != GeomType.CYLINDER or not face.is_circular_concave:
            continue
        surface = BRepAdaptor_Surface(face.wrapped)
        if not math.isclose(surface.LastUParameter() - surface.FirstUParameter(), math.tau, abs_tol=1e-6):
            continue
        cylinder = surface.Cylinder()
        if not math.isclose(2 * cylinder.Radius(), diameter, abs_tol=1e-6):
            continue
        direction = cylinder.Axis().Direction()
        axis = tuple(round(abs(value)) for value in (direction.X(), direction.Y(), direction.Z()))
        if axis in counts:
            counts[axis] += 1
    if counts != expected_axes:
        raise ValueError("STEP 回读的圆柱孔数量、轴向或孔径不符合规格。")


STRUCTURES = {"reinforced_bracket": ReinforcedBracket, "electronics_tray": ElectronicsTray}

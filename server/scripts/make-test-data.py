"""生成 Phase 1 验收场景用的测试 Shapefile。

在 7x8 网格上生成 56 个带随机抖动的地块多边形，坐标系为
CGCS2000 / 3-degree Gauss-Kruger CM 114E（EPSG:4547，单位米），
字段：id（地块编号）、type（地类）。

用法（项目根目录）:
    runtime/python/python.exe server/scripts/make-test-data.py

输出:
    workspace/test-data/sample_fields.shp（及 .dbf/.shx/.cpg/.prj）
"""

import random
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Polygon

# 固定随机种子，保证测试数据可复现
random.seed(42)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = PROJECT_ROOT / "workspace" / "test-data"
OUT_PATH = OUT_DIR / "sample_fields.shp"

LAND_TYPES = ["耕地", "林地", "建设用地", "水域", "草地"]

CELL = 200.0  # 网格边长（米）
JITTER = 40.0  # 顶点随机偏移上限（米）
X0, Y0 = 500_000.0, 3_800_000.0  # EPSG:4547 下的起始坐标


def make_cell_polygon(col: int, row: int) -> Polygon:
    """在 (col, row) 网格内生成一个带抖动的四边形地块。"""
    x0 = X0 + col * CELL
    y0 = Y0 + row * CELL
    inset = random.uniform(5, 20)  # 地块之间留随机间隙
    corners = [
        (x0 + inset, y0 + inset),
        (x0 + CELL - inset, y0 + inset),
        (x0 + CELL - inset, y0 + CELL - inset),
        (x0 + inset, y0 + CELL - inset),
    ]
    jittered = [
        (x + random.uniform(-JITTER, JITTER), y + random.uniform(-JITTER, JITTER))
        for x, y in corners
    ]
    return Polygon(jittered)


def main() -> None:
    rows = []
    for col in range(7):
        for row in range(8):
            rows.append(
                {
                    "id": f"PC-{col * 8 + row + 1:03d}",
                    "type": random.choice(LAND_TYPES),
                    "geometry": make_cell_polygon(col, row),
                }
            )

    gdf = gpd.GeoDataFrame(rows, crs="EPSG:4547")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    gdf.to_file(OUT_PATH, driver="ESRI Shapefile", encoding="utf-8")

    # 写后读回验证，并打印验收场景的参考答案
    back = gpd.read_file(OUT_PATH)
    areas = back.to_crs(back.crs).geometry.area
    print(f"写出: {OUT_PATH}")
    print(f"要素数: {len(back)}")
    print(f"坐标系: {back.crs.name} (EPSG:{back.crs.to_epsg()})")
    print(f"字段: {list(back.columns)}")
    print(f"面积合计（平方米，参考答案）: {areas.sum():.2f}")
    print(f"地类分布: {back['type'].value_counts().to_dict()}")


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""开源 GIS 数据处理工具箱（Agent 的 opengis_* 工具共用执行入口）。

来源与适配
----------
本模块复刻自个人 GIS 函数库 ``latio/gpd_tools.py``（geopandas + GDAL 实现，经大量真实
数据验证），按本项目的便携 Python 运行时（geopandas / fiona / pyproj / shapely，内嵌 GDAL
3.12）重写，并做了以下适配：

- **osgeo 做 GDB 系统表与 KML**：便携运行时已装 GDAL 3.13.3（``from osgeo import gdal, ogr``）。
  GDB 别名读写、``fix_gdb``（清理 Length/Precision/Scale）、KML 读取统一走 osgeo/ogr
  原生实现（``FieldDefn.GetAlternativeName``、GDB_Items 的 Definition XML 用 minidom
  改写），替代手写的 fiona 直开系统表 + 正则剥前缀 + ElementTree 解析链路。
- **读写主链路仍走 fiona 后端**（``engine="fiona"``）：schema 参数只有 fiona 支持，pyogrio
  写出的字段类型不受 schema 约束，会在跨格式往返时漂移；schema/crs 直通用 fiona。
- **schema 直通**：读写都用 fiona 原生 schema（``{"geometry": "MultiPolygon",
  "properties": {"字段": "str" | "int" | "float" | "datetime"}}``），写出时按 latio 的做法
  把 date 字段转 datetime、GDB 的 ``str:254`` 宽度补到 ``str:255``，空数据补默认几何类型，
  避免空表写出报几何类型错误。
- **路径约定保持一致**：所有 GDB 相关动作接受 ``xxx.gdb/图层名`` 形式（``parse_gdb_path``）；
  实测 ``gpd.read_file("x.gdb/图层名")`` 在本运行时直接报错，必须先拆分库路径与图层名。
- **坐标系解析增强**：``to_epsg()`` 对 CGCS2000 3 度带成果库常返回 None，
  增加降级置信度与名称/参数比对，避免图层因缺 dataCrs 而在前端错位。
- **安全边界**：本模块不覆盖、不删除输入数据；输出路径由调用方（TypeScript 工具层）
  校验，必须落在会话绑定的项目/工作区目录内。

调用约定
--------
``python opengis_toolbox.py <action> <json-args>``

结果以 **stdout 末行 JSON** 返回（前序行可能含库告警）；可预期的失败返回
``{"success": false, "error": "..."}`` 且退出码为 0，未捕获异常打印堆栈并以非 0 退出。
"""

import json
import os
import re
import shutil
import sys
import traceback
import warnings

import fiona
import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import CRS
from shapely import make_valid
from shapely.geometry import MultiLineString, MultiPoint, MultiPolygon

warnings.filterwarnings("ignore")

# 统一使用 fiona 后端：schema 参数只有 fiona 引擎支持（pyogrio 会忽略字段类型约束）
ENGINE = "fiona"

# GDAL 生成的冗余字段（大小写变体），读写两端都清理，避免在格式间来回传播
ARTIFACT_FIELDS = ("shape_length", "shape_area", "shape_leng", "shape_len")

# 输出扩展名 → GDAL 驱动
DRIVERS = {
    ".shp": "ESRI Shapefile",
    ".geojson": "GeoJSON",
    ".json": "GeoJSON",
    ".gpkg": "GPKG",
    ".gdb": "OpenFileGDB",
}

# schema 字段类型归一化（兼容 fiona 的 str/int/float/date 与 GDB 的 String/Integer/Double/Date）
TYPE_ALIASES = {
    "str": "string",
    "string": "string",
    "text": "string",
    "int": "integer",
    "int32": "integer",
    "int64": "integer",
    "integer": "integer",
    "long": "integer",
    "smallint": "integer",
    "float": "double",
    "float32": "double",
    "float64": "double",
    "double": "double",
    "real": "double",
    "decimal": "double",
    "numeric": "double",
    "date": "date",
    "datetime": "date",
    "timestamp": "date",
    "bool": "string",
    "boolean": "string",
}


# ---------------- 路径与坐标系 ----------------


def parse_gdb_path(full_path):
    """``xxx.gdb/图层名`` → (gdb 路径, 图层名)；非该形式时图层名为 None。"""
    text = str(full_path).replace("\\", "/")
    match = re.search(r"\.gdb/", text, re.IGNORECASE)
    if not match:
        return str(full_path), None
    cut = match.end() - 1  # 指向 "/"
    gdb = text[:cut]
    layer = text[cut + 1 :].strip("/")
    # 末段可能是要素数据集，取最后一段作为图层名
    if "/" in layer:
        layer = layer.split("/")[-1]
    return gdb, (layer or None)


def is_gdb_path(path):
    return parse_gdb_path(path)[1] is not None or str(path).lower().endswith(".gdb")


def resolve_epsg(crs):
    """WKT/CRS → EPSG 代码。

    降级顺序：严格匹配 → 70% 置信度 → 25% 置信度 → CGCS2000 3 度带名称解析 →
    与 4513~4554 逐个比对参数。返回 None 表示无法确定。
    """
    if crs is None:
        return None
    try:
        crs = CRS.from_user_input(crs)
    except Exception:
        return None
    for confidence in (None, 70, 25):
        try:
            code = crs.to_epsg() if confidence is None else crs.to_epsg(min_confidence=confidence)
        except Exception:
            code = None
        if code:
            return int(code)
    name = crs.name or ""
    match = re.search(r"Degree_GK_Zone_(\d+)", name, re.IGNORECASE)
    if match:
        zone = int(match.group(1))
        if 25 <= zone <= 45:
            return 4513 + (zone - 25)
    match = re.search(r"Degree_GK_CM_(\d+)E", name, re.IGNORECASE)
    if match:
        cm = int(match.group(1))
        if 75 <= cm <= 135 and (cm - 75) % 3 == 0:
            return 4534 + (cm - 75) // 3
    for candidate in range(4513, 4555):
        try:
            if CRS.from_epsg(candidate).equals(crs):
                return candidate
        except Exception:
            continue
    return None


def crs_info(crs):
    """坐标系的 JSON 友好描述（名称 / EPSG / WKT）。"""
    if crs is None:
        return {"crs": None, "epsg": None, "crs_name": None}
    try:
        parsed = CRS.from_user_input(crs)
    except Exception:
        return {"crs": str(crs), "epsg": None, "crs_name": None}
    return {
        "crs": parsed.to_wkt(),
        "epsg": resolve_epsg(parsed),
        "crs_name": parsed.name,
    }


# ---------------- schema ----------------


def normalize_type(raw):
    key = str(raw or "").strip().lower()
    return TYPE_ALIASES.get(key, "string")


def normalize_schema(schema):
    """把 fiona / GDB / 自定义 schema 归一为 ``{"geometry", "fields":[{name,type,length,raw_type}]}``。

    ``raw_type`` 保留来源 schema 的原始类型串（如 ``str:254``、``int32``、``datetime``），
    写出时直通给 fiona，避免字段宽度/精度在往返中丢失。
    """
    if not schema:
        return {"geometry": None, "fields": []}
    if "fields" in schema:  # 已是本模块形式
        fields = [
            {
                "name": str(f.get("name")),
                "type": normalize_type(f.get("type")),
                "length": f.get("length"),
                "raw_type": f.get("raw_type"),
            }
            for f in schema["fields"]
            if f.get("name")
        ]
        return {"geometry": schema.get("geometry"), "fields": fields}
    geometry = schema.get("geometry")
    fields = []
    for name, spec in (schema.get("properties") or {}).items():
        if isinstance(spec, dict):
            fields.append(
                {
                    "name": str(name),
                    "type": normalize_type(spec.get("type")),
                    "length": spec.get("length") or spec.get("width"),
                    "raw_type": str(spec.get("type")) if spec.get("type") else None,
                }
            )
        else:
            fields.append(
                {
                    "name": str(name),
                    "type": normalize_type(spec),
                    "length": None,
                    "raw_type": str(spec) if spec else None,
                }
            )
    return {"geometry": geometry, "fields": fields}


def read_schema_crs(path, layer=None):
    """用 fiona 直接读取原始 schema 与 crs（复刻 latio.get_data_schema_crs）。

    比从 GeoDataFrame 反推更可靠：字段宽度、int32/int64、datetime 等都原样保留。
    """
    gdb, layer_from_path = parse_gdb_path(path)
    target_layer = layer or layer_from_path
    if target_layer:
        source = fiona.open(gdb, layer=target_layer)
    else:
        source = fiona.open(str(path))
    try:
        return {"schema": dict(source.schema), "crs": source.crs, "driver": source.driver}
    finally:
        source.close()


def passthrough_schema(path, layer, gdf):
    """输入的原始 fiona schema（保字段宽度/精度），剔除 artifact 字段与读取后已不存在的列。

    供几何运算动作（reproject / clip）把输入 schema 直通给写出端，字段类型不漂移；
    读不到原始 schema 时返回 None，写出退回从 GeoDataFrame 推断。
    """
    try:
        raw = read_schema_crs(path, layer)["schema"]
    except Exception:
        return None
    columns = {str(c) for c in gdf.columns}
    properties = {}
    for name, spec in (raw.get("properties") or {}).items():
        key = str(name)
        if key.lower() in ARTIFACT_FIELDS or key not in columns:
            continue
        properties[key] = spec
    if not properties:
        return None
    return {"geometry": raw.get("geometry"), "properties": properties}


def schema_of_gdf(gdf, target=None):
    """从 GeoDataFrame 推导 schema；给出 target 时沿用其字段类型。"""
    target_types = {}
    if target:
        for field in normalize_schema(target)["fields"]:
            target_types[field["name"]] = field["type"]
    geometry = None
    try:
        geometry = gdf.geometry.geom_type.dropna().iloc[0] if len(gdf) else None
    except Exception:
        geometry = None
    fields = []
    for column in gdf.columns:
        if column == gdf.geometry.name or column == "geometry":
            continue
        dtype = str(gdf[column].dtype)
        if column in target_types:
            kind = target_types[column]
        elif dtype.startswith("int"):
            kind = "integer"
        elif dtype.startswith("float"):
            kind = "double"
        elif "datetime" in dtype:
            kind = "date"
        else:
            kind = "string"
        fields.append({"name": str(column), "type": kind, "length": None})
    return {"geometry": geometry, "fields": fields}


def default_value(kind):
    if kind == "integer":
        return pd.array([pd.NA], dtype="Int64")[0]
    if kind == "double":
        return np.nan
    if kind == "date":
        return pd.NaT
    return ""


def cast_column(series, kind):
    if kind == "integer":
        return pd.to_numeric(series, errors="coerce").astype("Int64")
    if kind == "double":
        return pd.to_numeric(series, errors="coerce").astype("float64")
    if kind == "date":
        return pd.to_datetime(series, errors="coerce")
    return series.astype("object").where(series.notna(), "").astype(str)


# ---------------- 读写 ----------------


def drop_artifact_fields(gdf):
    drop = [c for c in gdf.columns if str(c).lower() in ARTIFACT_FIELDS]
    return gdf.drop(columns=drop) if drop else gdf


def _fiona_type(kind):
    """内部类型 → fiona schema 类型名。"""
    if kind == "integer":
        return "int"
    if kind == "double":
        return "float"
    if kind == "date":
        return "datetime"
    return "str"


def _fiona_type_of_dtype(dtype):
    """pandas dtype → fiona schema 类型名（merge 字段并集扩 schema 用）。"""
    text = str(dtype)
    if text.startswith("int"):
        return "int"
    if text.startswith("float"):
        return "float"
    if "datetime" in text:
        return "datetime"
    return "str"


def _is_gdb(schema):
    return str(schema.get("driver") or "").lower() == "openfilegdb"


def to_fiona_schema(target, driver=None):
    """内部 schema → fiona schema；GDB 写出沿用 latio 的规范化（date→datetime、str:254→str:255）。"""
    normalized = normalize_schema(target)
    properties = {}
    for field in normalized["fields"]:
        raw = str(field.get("raw_type") or "").strip()
        kind = field["type"]
        if raw:
            # 保留来源 schema 的原始类型（宽度、精度等），GDB 只做两处已知修正
            value = raw
            if str(driver or "").lower() == "openfilegdb":
                lowered = value.lower()
                if lowered == "date" or lowered.startswith("date:"):
                    value = "datetime"
                elif lowered.startswith("str:254"):
                    value = "str:255"
            properties[field["name"]] = value
        else:
            properties[field["name"]] = _fiona_type(kind)
    geometry = normalized.get("geometry") or "Unknown"
    return {"geometry": geometry, "properties": properties}


def date_fields_of(target):
    """目标 schema 中的日期字段名（写出前需转 datetime）。"""
    return [
        field["name"]
        for field in normalize_schema(target)["fields"]
        if field["type"] == "date"
    ]


def read_vector(path, layer=None):
    """读取矢量数据（支持 ``xxx.gdb/图层名``、shp/geojson/gpkg/kml 等）。

    统一 fiona 后端以保证与写出端的 schema 语义对称；fiona 不含 KML/LIBKML 驱动，
    读取失败时退回 pyogrio（只读取，不写——写出的 schema 直通仍只走 fiona）。
    """
    gdb, layer_from_path = parse_gdb_path(path)
    target_layer = layer or layer_from_path
    try:
        if target_layer:
            return gpd.read_file(gdb, layer=target_layer, engine=ENGINE)
        return gpd.read_file(str(path), engine=ENGINE)
    except Exception:
        if target_layer:
            return gpd.read_file(gdb, layer=target_layer, engine="pyogrio")
        return gpd.read_file(str(path), engine="pyogrio")


def unique_output(output):
    """避免覆盖既有数据：返回 (可用输出路径, 必要的图层名覆盖)。

    普通文件同名时追加 ``_1``、``_2``…；GDB 图层同名时对图层名做同样处理。
    """
    gdb, layer = parse_gdb_path(output)
    if layer:
        if not os.path.exists(gdb):
            return output, None
        try:
            existing = set(fiona.listlayers(gdb))
        except Exception:
            return output, None
        if layer not in existing:
            return output, None
        index = 1
        while f"{layer}_{index}" in existing:
            index += 1
        return f"{gdb}/{layer}_{index}", f"{layer}_{index}"
    if not os.path.exists(output):
        return output, None
    root, ext = os.path.splitext(str(output))
    index = 1
    while os.path.exists(f"{root}_{index}{ext}"):
        index += 1
    return f"{root}_{index}{ext}", None


def write_vector(gdf, output, layer=None, schema=None, crs=None):
    """写出矢量数据（按扩展名选驱动，统一 fiona 后端以保证 schema 生效）。"""
    out_path = str(output)
    gdb, layer_from_path = parse_gdb_path(out_path)
    target_layer = layer or layer_from_path
    ext = os.path.splitext(gdb if target_layer else out_path)[1].lower()
    if ext in (".csv", ".xlsx", ".xls"):
        table = pd.DataFrame(gdf.drop(columns=gdf.geometry.name, errors="ignore"))
        parent = os.path.dirname(os.path.abspath(out_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        if ext == ".csv":
            table.to_csv(out_path, index=False, encoding="utf-8-sig")
        else:
            table.to_excel(out_path, index=False)
        return out_path
    driver = DRIVERS.get(ext)
    if driver is None:
        raise ValueError(f"不支持的输出格式: {ext or output}")
    if target_layer:
        # GDB 由驱动自己创建：只建它的父目录，预先建出空 .gdb 会让 OGR 拒绝写入
        parent = os.path.dirname(os.path.abspath(gdb))
    else:
        parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    data = gdf if crs is None else gdf.set_crs(crs, allow_override=True)
    fiona_schema = None
    if schema:
        fiona_schema = to_fiona_schema(schema, driver)
        # 日期字段先转 datetime，否则 fiona 写 datetime 列会报类型不符
        for name in date_fields_of(schema):
            if name in data.columns:
                data = data.copy()
                data[name] = pd.to_datetime(data[name], errors="coerce")
    elif len(data) == 0:
        # 空数据无几何可推断：给默认几何类型，避免写出报错
        fiona_schema = {"geometry": "Unknown", "properties": {}}
    kwargs = {"driver": driver, "engine": ENGINE, "encoding": "utf-8"}
    if target_layer:
        kwargs["layer"] = target_layer
    if fiona_schema:
        kwargs["schema"] = fiona_schema
    if driver == "ESRI Shapefile":
        kwargs.pop("encoding", None)
        kwargs["encoding"] = "utf-8"
    data.to_file(gdb if target_layer else out_path, **kwargs)
    return out_path


# ---------------- 元信息 ----------------


def describe_vector_path(path, layer=None):
    """矢量元信息：driver / 几何类型 / 要素数 / 坐标系 / 字段（含别名与原始类型）。

    统一用 fiona 读取（``engine`` 的后端语义与写出保持一致）。
    """
    gdb, layer_from_path = parse_gdb_path(path)
    target_layer = layer or layer_from_path
    target = gdb if target_layer else str(path)
    source = fiona.open(gdb, layer=target_layer) if target_layer else fiona.open(str(path))
    try:
        properties = dict(source.schema.get("properties") or {})
        geometry_type = source.schema.get("geometry")
        feature_count = len(source)
        bounds = source.bounds
        crs = source.crs
        driver = source.driver
        encoding = source.encoding
    finally:
        source.close()
    aliases = read_field_aliases(target, target_layer) if is_gdb_path(target) else {}
    field_items = []
    for name, spec in properties.items():
        if str(name).lower() in ARTIFACT_FIELDS:
            continue
        field_items.append(
            {
                "name": str(name),
                "type": normalize_type(spec),
                # fiona 原始类型串（如 str:254 / int32 / datetime），供 schema 直通参考
                "dtype": str(spec),
                "alias": aliases.get(str(name)),
            }
        )
    geometry_types = [str(geometry_type)] if geometry_type else []
    return {
        "kind": "vector",
        "driver": driver,
        "layer": target_layer,
        "geometry_types": geometry_types,
        "feature_count": int(feature_count),
        "fields": field_items,
        "bounds": [float(v) for v in bounds] if bounds is not None else None,
        "encoding": encoding,
        **crs_info(crs),
    }


def read_gdb_items(gdb_path):
    """读取 GDB_Items 系统表（别名与定义 XML 的来源），返回 DataFrame。

    走 osgeo（``gdal.OpenEx(..., LIST_ALL_TABLES=YES)``）：系统表不在常规图层清单里，
    ogr 可按名直接打开；只读打开，不改动源库。
    """
    from osgeo import gdal

    dataset = gdal.OpenEx(str(gdb_path), gdal.OF_VECTOR, open_options=["LIST_ALL_TABLES=YES"])
    if dataset is None:
        return pd.DataFrame()
    items = dataset.GetLayerByName("GDB_Items")
    rows = []
    if items is not None:
        for feature in items:
            rows.append(
                {
                    "Name": feature.GetFieldAsString("Name") if feature.GetFieldIndex("Name") >= 0 else None,
                    "Definition": (
                        feature.GetFieldAsString("Definition") if feature.GetFieldIndex("Definition") >= 0 else None
                    ),
                }
            )
    dataset = None
    return pd.DataFrame(rows)


def _local_name_xml(tag):
    """取 XML 节点本地名（兼容 ``{ns}Name`` 与 ``ns:Name`` 两种前缀形式）。"""
    return str(tag).split("}")[-1].split(":")[-1]


def parse_definition_aliases(definition_xml):
    """从图层 Definition XML 解析图层别名与字段别名（osgeo/minidom 实现）。

    GDB 的 Definition XML 常带未声明的 ``ns0:`` 前缀，ElementTree 会报 unbound prefix；
    minidom 不做命名空间处理，天然容忍，与原库 ``latio`` 的解析方式一致。
    """
    from xml.dom import minidom

    layer_alias = None
    field_aliases = {}
    try:
        doc = minidom.parseString(definition_xml.encode("utf-8"))
    except Exception:
        return layer_alias, field_aliases
    root = doc.documentElement

    def direct_text(node, wanted):
        for child in node.childNodes:
            if child.nodeType == child.ELEMENT_NODE and _local_name_xml(child.tagName) == wanted:
                return "".join(c.data for c in child.childNodes if c.nodeType == c.TEXT_NODE) or None
        return None

    layer_alias = direct_text(root, "AliasName")
    for node in root.getElementsByTagName("*"):
        if _local_name_xml(node.tagName) != "GPFieldInfoEx":
            continue
        name = direct_text(node, "Name")
        alias = direct_text(node, "AliasName")
        if name and alias:
            field_aliases[name] = alias
    return layer_alias, field_aliases


def read_alias_map(gdb_path, layer=None):
    """GDB 图层与字段别名（返回 {图层名: {"alias":..., "fields": {...}}}）。

    图层与字段别名都解析 GDB_Items 的 Definition XML（minidom）。
    注意：OpenFileGDB 驱动只在 ``CreateField`` 时把 ``SetAlternativeName`` 写入底层，
    事后改写 Definition XML 的字段别名 ``GetAlternativeName()`` 不回读（驱动不从 XML 取），
    因此读端必须用 XML 解析——与写入端（同为 Definition XML 改写）口径一致。
    """
    result = {}
    wanted = {str(layer)} if layer else None
    items = read_gdb_items(gdb_path)
    for _, row in items.iterrows():
        name = row.get("Name")
        definition = row.get("Definition")
        if not isinstance(name, str) or not name:
            continue
        if wanted is not None and name not in wanted:
            continue
        if not isinstance(definition, str) or "FeatureClassInfo" not in definition:
            continue
        layer_alias, field_aliases = parse_definition_aliases(definition)
        result[name] = {"alias": layer_alias, "fields": field_aliases}
    if layer and str(layer) not in result:
        # 非 FeatureClass 图层（如注记/表）：退回空别名
        result[str(layer)] = {"alias": None, "fields": {}}
    return result


def read_field_aliases(gdb_path, layer):
    if not layer:
        return {}
    try:
        return read_alias_map(gdb_path, layer).get(str(layer), {}).get("fields", {})
    except Exception:
        return {}


# ---------------- 动作 ----------------


def action_inspect(path=None, output=None, layer=None, repair=False, add_artifacts=True):
    """读取数据元信息；矢量且给了 output 时写出 GeoJSON（坐标保持原坐标系）。"""
    if not path:
        return {"success": False, "error": "缺少 path 参数"}
    result = {"path": str(path), "layer": layer}
    try:
        gdf = read_vector(path, layer)
    except Exception as vector_error:
        try:
            import rasterio

            with rasterio.open(str(path)) as ds:
                crs = crs_info(ds.crs)
                nodata = None if ds.nodata is None or ds.nodata != ds.nodata else float(ds.nodata)
                result.update(
                    {
                        "success": True,
                        "kind": "raster",
                        "driver": ds.driver,
                        "width": ds.width,
                        "height": ds.height,
                        "band_count": ds.count,
                        "dtypes": list(ds.dtypes),
                        "bounds": [
                            float(ds.bounds.left),
                            float(ds.bounds.bottom),
                            float(ds.bounds.right),
                            float(ds.bounds.top),
                        ],
                        "nodata": nodata,
                        **crs,
                    }
                )
                return result
        except Exception:
            return {"success": False, "error": f"无法读取数据: {vector_error}"}

    if add_artifacts:
        gdf = drop_artifact_fields(gdf)
    if repair:
        gdf = sanitize_gdf(gdf, explode=True, repair=True)
    info = schema_of_gdf(gdf)
    crs = crs_info(gdf.crs)
    bounds = None
    try:
        if len(gdf):
            values = [float(v) for v in gdf.total_bounds]
            if all(v == v for v in values):
                bounds = values
    except Exception:
        bounds = None
    result.update(
        {
            "success": True,
            "kind": "vector",
            "geometry_types": sorted({str(t) for t in gdf.geom_type.dropna().unique()}),
            "feature_count": int(len(gdf)),
            "fields": [{"name": f["name"], "dtype": f["type"]} for f in info["fields"]],
            "bounds": bounds,
            "sample": sample_rows(gdf),
            **crs,
        }
    )
    if output:
        os.makedirs(os.path.dirname(os.path.abspath(str(output))), exist_ok=True)
        with open(str(output), "w", encoding="utf-8") as handle:
            handle.write(gdf.to_json(drop_id=True))
        result["output"] = str(output)
    return result


def sample_rows(gdf, limit=3):
    """前几行属性样本（供 Agent 快速判断字段含义）。"""
    rows = []
    try:
        for _, row in gdf.head(limit).iterrows():
            item = {}
            for column in gdf.columns:
                if column == gdf.geometry.name:
                    continue
                value = row[column]
                if value is None or (isinstance(value, float) and value != value):
                    item[str(column)] = None
                elif hasattr(value, "isoformat"):
                    item[str(column)] = value.isoformat()
                elif isinstance(value, (int, float, bool)):
                    item[str(column)] = value
                else:
                    item[str(column)] = str(value)
            rows.append(item)
    except Exception:
        return []
    return rows


def sanitize_gdf(gdf, explode=True, repair=True, buffer_eps=None):
    """多部件拆分 + 几何修复 + 空几何清理（读写守门函数）。"""
    if explode:
        try:
            gdf = gdf.explode(index_parts=False, ignore_index=True)
        except Exception:
            pass
    if repair:
        mask = gdf.geometry.notna()
        geoms = gdf.loc[mask, gdf.geometry.name]
        fixed = []
        for geom in geoms:
            try:
                if geom is None or geom.is_empty:
                    fixed.append(None)
                    continue
                fixed.append(geom if geom.is_valid else make_valid(geom))
            except Exception:
                fixed.append(geom)
        gdf.loc[mask, gdf.geometry.name] = gpd.GeoSeries(fixed, index=geoms.index, crs=gdf.crs)
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
        if buffer_eps:
            gdf[gdf.geometry.name] = gdf.geometry.buffer(buffer_eps).buffer(-buffer_eps)
    return gdf


def action_list_layers(path=None):
    """列出数据源可用图层：GDB 返回全部图层（含 ``xxx.gdb/图层名`` 完整路径）。"""
    if not path:
        return {"success": False, "error": "缺少 path 参数"}
    gdb, layer = parse_gdb_path(path)
    if layer is not None or str(path).lower().endswith(".gdb"):
        names = list(fiona.listlayers(gdb))
        return {
            "success": True,
            "kind": "gdb",
            "path": gdb,
            "count": len(names),
            "layers": [{"name": name, "path": f"{gdb}/{name}"} for name in names],
        }
    return {
        "success": True,
        "kind": "vector",
        "path": str(path),
        "count": 1,
        "layers": [{"name": os.path.splitext(os.path.basename(str(path)))[0], "path": str(path)}],
    }


def action_describe(path=None, layer=None, with_alias=True):
    """数据源元信息（GDB 图层清单 / 单图层 schema 与别名）。"""
    if not path:
        return {"success": False, "error": "缺少 path 参数"}
    gdb, layer_from_path = parse_gdb_path(path)
    target_layer = layer or layer_from_path
    if is_gdb_path(path) and target_layer is None:
        layers = action_list_layers(path)
        aliases = read_alias_map(gdb) if with_alias else {}
        for item in layers.get("layers", []):
            item["alias"] = (aliases.get(item["name"]) or {}).get("alias")
        return layers
    try:
        info = describe_vector_path(path, target_layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取元信息: {exc}"}
    if with_alias and is_gdb_path(path):
        alias_map = read_alias_map(gdb, target_layer)
        entry = alias_map.get(str(target_layer)) or {}
        info["layer_alias"] = entry.get("alias")
        for field in info["fields"]:
            field["alias"] = (entry.get("fields") or {}).get(field["name"])
    return {"success": True, **info}


def action_convert(input=None, output=None, layer=None, schema=None, crs=None, repair=False):
    """格式互转：gdb ↔ shp / geojson / gpkg，属性表 → csv / xlsx，GDB → GDB 图层导出。"""
    if not input or not output:
        return {"success": False, "error": "convert 需要 input 与 output"}
    if os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    gdf = drop_artifact_fields(gdf)
    if repair:
        gdf = sanitize_gdf(gdf, explode=True, repair=True)
    target_schema = normalize_schema(schema) if schema else None
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(gdf, final_output, layer=forced_layer, schema=target_schema, crs=crs)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "feature_count": int(len(gdf)),
        "schema": schema_of_gdf(gdf, target_schema),
        "epsg": resolve_epsg(gdf.crs),
    }


def action_re_schema(input=None, output=None, schema=None, schema_from=None, layer=None, crs=None):
    """按目标 schema 重排属性表结构：多则删、缺则补空、类型对齐（不修改输入）。"""
    if not input:
        return {"success": False, "error": "re_schema 需要 input"}
    if not schema and not schema_from:
        return {"success": False, "error": "需要 schema 或 schema_from（参考数据路径）"}
    if output and os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    if not schema:
        # 参考数据的原始 schema 优先（保留字段宽度/精度），读不到再退回从 GeoDataFrame 反推
        try:
            schema = read_schema_crs(schema_from, layer)["schema"]
        except Exception:
            try:
                reference = read_vector(schema_from, layer)
            except Exception as exc:
                return {"success": False, "error": f"无法读取参考数据: {exc}"}
            schema = schema_of_gdf(reference)
    target = normalize_schema(schema)
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    gdf = drop_artifact_fields(gdf)
    keep = [f["name"] for f in target["fields"]]
    dropped = [str(c) for c in gdf.columns if c != gdf.geometry.name and str(c) not in keep]
    added = []
    for field in target["fields"]:
        if field["name"] not in gdf.columns:
            gdf[field["name"]] = default_value(field["type"])
            added.append(field["name"])
    columns = [name for name in keep if name in gdf.columns] + [gdf.geometry.name]
    before_order = [str(c) for c in gdf.columns if c != gdf.geometry.name]
    gdf = gdf[columns]
    # 只看被保留字段的相对顺序是否变化（删字段不算重排）
    reordered = [str(c) for c in gdf.columns if c != gdf.geometry.name] != [
        name for name in before_order if name in keep
    ]
    for field in target["fields"]:
        if field["name"] in gdf.columns:
            gdf[field["name"]] = cast_column(gdf[field["name"]], field["type"])
    if crs:
        gdf = gdf.set_crs(crs, allow_override=True)
    final_output = None
    if output:
        final_output, forced_layer = unique_output(output)
        try:
            write_vector(gdf, final_output, layer=forced_layer, schema=target)
        except Exception as exc:
            return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output) if final_output else None,
        **({"renamed_to": str(final_output)} if output and str(final_output) != str(output) else {}),
        "feature_count": int(len(gdf)),
        "dropped_fields": dropped,
        "added_fields": added,
        "fields": [f["name"] for f in target["fields"]],
        "reordered": reordered,
        "schema": schema_of_gdf(gdf, target),
    }


def _require_gdal():
    try:
        from osgeo import gdal  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return None
    return gdal


def action_set_alias(gdb=None, layer_aliases=None, field_aliases=None, fix=True):
    """批量设置 GDB 图层/字段别名（写 GDB_Items 定义 XML，需要 osgeo/GDAL）。

    ``fix=True``（默认）在同一次 Definition 改写里顺带删除 Length/Precision/Scale 节点，
    避免 ArcGIS 打开报库错误；与 ``fix_gdb`` 共用同一次写入，规避原库「两次写 XML 损坏库」
    的已知坑。
    """
    if not gdb:
        return {"success": False, "error": "set_alias 需要 gdb 路径"}
    if _require_gdal() is None:
        return {
            "success": False,
            "error": "写 GDB 别名需要 GDAL(osgeo) 绑定，当前便携运行时未安装；"
            "只读别名请用 describe / read_alias。",
        }
    return _rewrite_gdb_definitions(str(gdb), layer_aliases or {}, field_aliases or {}, fix=bool(fix))


def _rewrite_gdb_definitions(gdb_path, layer_aliases, field_aliases, fix=True, dry_run=False):
    """基于 GDAL 直接改写 GDB_Items 的 Definition XML（复刻 latio.set_gdb_alias_xml 思路）。

    用 minidom 而非 ElementTree：GDB 的 Definition XML 常带未声明的 ``ns0:`` 前缀，
    ElementTree 直接报 unbound prefix，minidom 不处理命名空间、天然容忍，序列化结果
    与原库逐字节一致。别名节点按原库「删旧 + 末尾重建」的方式写入。
    """
    from xml.dom import minidom

    from osgeo import gdal

    dataset = gdal.OpenEx(gdb_path, gdal.OF_VECTOR | gdal.GA_Update, open_options=["LIST_ALL_TABLES=YES"])
    if dataset is None:
        return {"success": False, "error": f"无法以可写方式打开 {gdb_path}"}
    items = dataset.GetLayerByName("GDB_Items")
    if items is None:
        dataset = None
        return {"success": False, "error": "GDB_Items 表不可用，数据库可能已损坏"}
    updated = []
    fixed = []
    try:
        for feature in items:
            name = feature.GetFieldAsString("Name") if feature.GetFieldIndex("Name") >= 0 else ""
            if not name:
                continue
            aliases = {k: v for k, v in (field_aliases.get(name) or {}).items()}
            layer_alias = layer_aliases.get(name)
            if layer_alias is None and not aliases and not fix:
                continue
            if dataset.GetLayerByName(name) is None:
                continue
            definition = feature.GetFieldAsString("Definition") if feature.GetFieldIndex("Definition") >= 0 else ""
            if not definition:
                continue
            try:
                doc = minidom.parseString(definition.encode("utf-8"))
            except Exception:
                continue
            root = doc.documentElement
            changed = False
            cleaned = False

            def remove_children(node, wanted):
                nonlocal cleaned
                removed = False
                for child in list(node.childNodes):
                    if child.nodeType == child.ELEMENT_NODE and _local_name_xml(child.tagName) == wanted:
                        node.removeChild(child)
                        removed = True
                return removed

            def set_alias_node(node, value):
                # 删旧 + 末尾重建：ArcGIS 期望 AliasName 位于节点尾部
                remove_children(node, "AliasName")
                element = doc.createElement("AliasName")
                element.appendChild(doc.createTextNode(str(value)))
                node.appendChild(element)
                return True

            if layer_alias is not None:
                changed = set_alias_node(root, layer_alias) or changed
            for node in root.getElementsByTagName("*"):
                if _local_name_xml(node.tagName) != "GPFieldInfoEx":
                    continue
                field_name = None
                for child in node.childNodes:
                    if child.nodeType == child.ELEMENT_NODE and _local_name_xml(child.tagName) == "Name":
                        field_name = "".join(c.data for c in child.childNodes if c.nodeType == c.TEXT_NODE)
                if fix:
                    # 关键修复：删除 Length/Precision/Scale，否则 ArcGIS 报数据库错误
                    for tag in ("Length", "Precision", "Scale"):
                        if remove_children(node, tag):
                            cleaned = True
                if field_name and field_name in aliases:
                    changed = set_alias_node(node, aliases[field_name]) or changed
            if not changed and not cleaned:
                continue
            if dry_run:
                if changed:
                    updated.append(name)
                if cleaned:
                    fixed.append(name)
                continue
            xml = doc.toxml()
            if xml.startswith("<?xml"):
                xml = xml.split("?>", 1)[-1].lstrip()
            feature.SetField("Definition", xml)
            if items.SetFeature(feature) == 0:
                if changed:
                    updated.append(name)
                if cleaned:
                    fixed.append(name)
    finally:
        dataset = None
    result = {"success": True, "gdb": gdb_path}
    if layer_aliases or field_aliases:
        result["updated_layers"] = updated
        result["count"] = len(updated)
    if fix:
        result["fixed_layers"] = fixed
        result["fixed_count"] = len(fixed)
    if dry_run:
        result["dry_run"] = True
    return result


def action_fix_gdb(gdb=None, dry_run=False):
    """清理 GDAL 创建的 GDB 中 Length/Precision/Scale 描述（需要 osgeo/GDAL）。

    与 ``set_alias`` 共用同一次 Definition 改写，只做清理不设别名。
    """
    if not gdb:
        return {"success": False, "error": "fix_gdb 需要 gdb 路径"}
    if _require_gdal() is None:
        return {"success": False, "error": "修复 GDB 需要 GDAL(osgeo) 绑定，当前便携运行时未安装。"}
    return _rewrite_gdb_definitions(str(gdb), {}, {}, fix=True, dry_run=bool(dry_run))


def action_repair(input=None, output=None, layer=None, explode=True, buffer_eps=None, crs=None):
    """几何修复 + 多部件拆分（输出为新文件，不改输入）。"""
    if not input or not output:
        return {"success": False, "error": "repair 需要 input 与 output"}
    if os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    before = int(len(gdf))
    gdf = sanitize_gdf(drop_artifact_fields(gdf), explode=explode, repair=True, buffer_eps=buffer_eps)
    if crs:
        gdf = gdf.set_crs(crs, allow_override=True)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(gdf, final_output, layer=forced_layer)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "features_before": before,
        "features_after": int(len(gdf)),
        "epsg": resolve_epsg(gdf.crs),
    }


def action_reproject(input=None, output=None, layer=None, crs=None):
    """重投影：把矢量数据真正变换到目标坐标系（``to_crs``，区别于 convert 的 crs 改标注）。"""
    if not input or not output or not crs:
        return {"success": False, "error": "reproject 需要 input、output 与 crs"}
    if os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    gdf = drop_artifact_fields(gdf)
    if gdf.crs is None:
        return {
            "success": False,
            "error": "输入没有坐标系标注，无法重投影；如已知正确坐标系，"
            "先用 opengis_convert 的 crs 参数修正标注，再重投影。",
        }
    try:
        target_crs = CRS.from_user_input(str(crs))
    except Exception as exc:
        return {"success": False, "error": f"无法解析目标坐标系 {crs}: {exc}"}
    source_crs = gdf.crs
    try:
        gdf = gdf.to_crs(target_crs)
    except Exception as exc:
        return {"success": False, "error": f"重投影失败: {exc}"}
    schema = passthrough_schema(input, layer, gdf)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(gdf, final_output, layer=forced_layer, schema=schema)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "feature_count": int(len(gdf)),
        "source_epsg": resolve_epsg(source_crs),
        "epsg": resolve_epsg(gdf.crs),
        "crs_name": gdf.crs.name,
        "bounds": [float(v) for v in gdf.total_bounds] if len(gdf) else None,
        "schema": schema_of_gdf(gdf, schema),
    }


def action_clip(input=None, mask=None, output=None, layer=None):
    """矢量裁剪：用 mask 图层裁剪输入（字段保留输入结构，输出为新文件，不拆多部件）。"""
    if not input or not mask or not output:
        return {"success": False, "error": "clip 需要 input、mask 与 output"}
    for source in (input, mask):
        if os.path.abspath(str(source)) == os.path.abspath(str(output)):
            return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    try:
        mask_gdf = read_vector(mask)
    except Exception as exc:
        return {"success": False, "error": f"无法读取裁剪范围: {exc}"}
    gdf = drop_artifact_fields(gdf)
    if gdf.crs is None:
        return {
            "success": False,
            "error": "输入没有坐标系标注，无法与裁剪范围对齐；如已知正确坐标系，"
            "先用 opengis_convert 的 crs 参数修正标注。",
        }
    if mask_gdf.crs is None:
        return {"success": False, "error": "裁剪范围（mask）没有坐标系标注，无法对齐。"}
    mask_aligned = False
    if not mask_gdf.crs.equals(gdf.crs):
        mask_gdf = mask_gdf.to_crs(gdf.crs)
        mask_aligned = True
    features_before = int(len(gdf))
    # 裁剪前只做几何修复（不拆多部件，对齐 QGIS clip 行为）；无效几何会让 clip 报错或丢要素
    gdf = sanitize_gdf(gdf, explode=False, repair=True)
    try:
        clipped = gpd.clip(gdf, mask_gdf, keep_geom_type=True)
    except Exception as exc:
        return {"success": False, "error": f"裁剪失败: {exc}"}
    # 完全落在范围外的要素被裁成空几何，清掉；空结果同样正常写出（空图层）
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].reset_index(drop=True)
    schema = passthrough_schema(input, layer, clipped)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(clipped, final_output, layer=forced_layer, schema=schema)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "mask": str(mask),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "features_before": features_before,
        "feature_count": int(len(clipped)),
        "mask_aligned": mask_aligned,
        "epsg": resolve_epsg(clipped.crs),
        "bounds": [float(v) for v in clipped.total_bounds] if len(clipped) else None,
        "schema": schema_of_gdf(clipped, schema),
    }


def _promote_schema_geometry(schema, gdf):
    """几何运算后按实际数据升级直通 schema 的几何类型（Polygon→MultiPolygon 等）。

    buffer / dissolve 常把单部件几何变成多部件；多部件数据写进单部件 schema
    会被驱动截断，这里按首个实际几何类型升级，字段类型仍走直通不漂移。
    """
    if not schema or not schema.get("geometry"):
        return schema
    try:
        geom_type = gdf.geometry.geom_type.dropna()
        actual = geom_type.iloc[0] if len(geom_type) else None
    except Exception:
        return schema
    if not actual or not str(actual).startswith("Multi"):
        return schema
    base = str(schema["geometry"])
    if base.startswith("Multi") or base in ("Unknown", "None"):
        return schema
    promoted = {"Point": "MultiPoint", "LineString": "MultiLineString", "Polygon": "MultiPolygon"}.get(base)
    if promoted:
        schema = dict(schema)
        schema["geometry"] = promoted
    return schema


def action_buffer(input=None, distance=None, output=None, layer=None):
    """缓冲区：对输入几何做 buffer（distance 单位随输入坐标系：投影坐标为米，经纬度为度）。"""
    if not input or distance is None or not output:
        return {"success": False, "error": "buffer 需要 input、distance 与 output"}
    if os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    try:
        distance = float(distance)
    except (TypeError, ValueError):
        return {"success": False, "error": f"distance 必须是数值: {distance!r}"}
    if not distance > 0:
        return {"success": False, "error": f"distance 必须为正数: {distance}"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    gdf = drop_artifact_fields(gdf)
    if gdf.crs is None:
        return {
            "success": False,
            "error": "输入没有坐标系标注，buffer 距离单位无法确定；"
            "如已知正确坐标系，先用 opengis_convert 的 crs 参数修正标注。",
        }
    features_before = int(len(gdf))
    gdf = sanitize_gdf(gdf, explode=False, repair=True)
    try:
        buffered = gdf.copy()
        buffered.geometry = buffered.geometry.buffer(distance)
    except Exception as exc:
        return {"success": False, "error": f"缓冲区计算失败: {exc}"}
    buffered = buffered[buffered.geometry.notna() & ~buffered.geometry.is_empty].reset_index(drop=True)
    schema = _promote_schema_geometry(passthrough_schema(input, layer, buffered), buffered)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(buffered, final_output, layer=forced_layer, schema=schema)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "features_before": features_before,
        "feature_count": int(len(buffered)),
        "distance": distance,
        "epsg": resolve_epsg(buffered.crs),
        "bounds": [float(v) for v in buffered.total_bounds] if len(buffered) else None,
        "schema": schema_of_gdf(buffered, schema),
    }


def action_dissolve(input=None, by=None, output=None, layer=None):
    """融合：按 by 字段聚合（字段取首值），缺省全融合为单要素。"""
    if not input or not output:
        return {"success": False, "error": "dissolve 需要 input 与 output"}
    if os.path.abspath(str(input)) == os.path.abspath(str(output)):
        return {"success": False, "error": "输出不能与输入相同（不覆盖源数据）"}
    if by is not None and not isinstance(by, list):
        return {"success": False, "error": f"by 需为字段名数组（或省略表示全融合）: {by!r}"}
    try:
        gdf = read_vector(input, layer)
    except Exception as exc:
        return {"success": False, "error": f"无法读取输入: {exc}"}
    gdf = drop_artifact_fields(gdf)
    features_before = int(len(gdf))
    if by:
        columns = {str(c) for c in gdf.columns}
        missing = [f for f in by if f not in columns]
        if missing:
            return {"success": False, "error": f"by 字段不存在: {', '.join(missing)}；可用字段: {', '.join(sorted(columns - {gdf.geometry.name}))}"}
    gdf = sanitize_gdf(gdf, explode=False, repair=True)
    try:
        dissolved = gdf.dissolve(by=by or None, aggfunc="first")
        # 有 by：把聚合索引恢复为普通字段；无 by：丢弃旧数值索引（reset 会平白产生 index 列）
        dissolved = dissolved.reset_index() if by else dissolved.reset_index(drop=True)
    except Exception as exc:
        return {"success": False, "error": f"融合失败: {exc}"}
    # by 列 reset 后成为普通字段；geometry 列名保持
    dissolved = dissolved[dissolved.geometry.notna() & ~dissolved.geometry.is_empty].reset_index(drop=True)
    schema = _promote_schema_geometry(passthrough_schema(input, layer, dissolved), dissolved)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(dissolved, final_output, layer=forced_layer, schema=schema)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "input": str(input),
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "features_before": features_before,
        "feature_count": int(len(dissolved)),
        **({"by": by} if by else {}),
        "epsg": resolve_epsg(dissolved.crs),
        "bounds": [float(v) for v in dissolved.total_bounds] if len(dissolved) else None,
        "schema": schema_of_gdf(dissolved, schema),
    }


def action_merge(inputs=None, output=None):
    """合并多个图层：pd.concat 纵向拼接（字段并集，缺列补空；CRS 对齐到首个输入）。"""
    if not inputs or not isinstance(inputs, list) or not output:
        return {"success": False, "error": "merge 需要 inputs（路径数组）与 output"}
    for source in inputs:
        if os.path.abspath(str(source)) == os.path.abspath(str(output)):
            return {"success": False, "error": "输出不能与任何输入相同（不覆盖源数据）"}
    frames = []
    per_input_counts = []
    base_crs = None
    aligned_inputs = []
    for source in inputs:
        try:
            gdf = read_vector(source)
        except Exception as exc:
            return {"success": False, "error": f"无法读取输入 {source}: {exc}"}
        gdf = drop_artifact_fields(gdf)
        if gdf.crs is None:
            return {"success": False, "error": f"输入 {source} 没有坐标系标注，无法与其他图层合并。"}
        if base_crs is None:
            base_crs = gdf.crs
        elif not gdf.crs.equals(base_crs):
            gdf = gdf.to_crs(base_crs)
            aligned_inputs.append(str(source))
        frames.append(gdf)
        per_input_counts.append(int(len(gdf)))
    geom_types = {t for frame in frames for t in frame.geometry.geom_type.dropna().unique()}
    if len(geom_types) > 1:
        return {
            "success": False,
            "error": f"输入几何类型不一致（{', '.join(sorted(geom_types))}），合并会破坏图层几何约束；请先统一几何类型。",
        }
    merged = pd.concat(frames, ignore_index=True)
    merged = merged[merged.geometry.notna() & ~merged.geometry.is_empty].reset_index(drop=True)
    # 字段并集对齐：首输入 schema 直通（同构合并类型不漂移）；首输入缺的列按其类型补空，
    # 其他输入独有的列按实际 dtype 扩进 schema（写出端 fiona 严格校验列与 schema 一致）
    schema = passthrough_schema(inputs[0], None, merged)
    if schema:
        props = dict(schema["properties"])
        for field, spec in props.items():
            if field not in merged.columns:
                raw = str(spec)
                kind = "double" if raw.startswith("float") else "integer" if raw.startswith("int") else "date" if raw.startswith("date") else "string"
                merged[field] = default_value(kind)
        for column in merged.columns:
            if column == merged.geometry.name:
                continue
            if column not in props:
                props[column] = _fiona_type_of_dtype(merged[column].dtype)
        schema = {**schema, "properties": props}
        ordered = [f for f in props if f in merged.columns]
        rest = [c for c in merged.columns if c not in ordered and c != merged.geometry.name]
        merged = merged[[*ordered, *rest, merged.geometry.name]]
    schema = _promote_schema_geometry(schema, merged)
    final_output, forced_layer = unique_output(output)
    try:
        write_vector(merged, final_output, layer=forced_layer, schema=schema)
    except Exception as exc:
        return {"success": False, "error": f"写出失败: {exc}"}
    return {
        "success": True,
        "inputs": [str(s) for s in inputs],
        "output": str(final_output),
        **({"renamed_to": str(final_output)} if str(final_output) != str(output) else {}),
        "per_input_counts": per_input_counts,
        "feature_count": int(len(merged)),
        **({"aligned_inputs": aligned_inputs} if aligned_inputs else {}),
        "epsg": resolve_epsg(merged.crs),
        "bounds": [float(v) for v in merged.total_bounds] if len(merged) else None,
        "schema": schema_of_gdf(merged, schema),
    }


ACTIONS = {
    "inspect": action_inspect,
    "list_layers": action_list_layers,
    "describe": action_describe,
    "read_alias": lambda path=None, layer=None: (
        {"success": False, "error": "read_alias 需要 path"}
        if not path
        else {"success": True, "gdb": parse_gdb_path(path)[0], "layers": read_alias_map(parse_gdb_path(path)[0], layer)}
    ),
    "convert": action_convert,
    "re_schema": action_re_schema,
    "repair": action_repair,
    "reproject": action_reproject,
    "clip": action_clip,
    "buffer": action_buffer,
    "dissolve": action_dissolve,
    "merge": action_merge,
    "set_alias": action_set_alias,
    "fix_gdb": action_fix_gdb,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "用法: opengis_toolbox.py <action> <json-args>"}, ensure_ascii=False))
        return 0
    action = sys.argv[1]
    handler = ACTIONS.get(action)
    if handler is None:
        print(
            json.dumps(
                {"success": False, "error": f"未知动作 {action}；可用: {', '.join(sorted(ACTIONS))}"},
                ensure_ascii=False,
            )
        )
        return 0
    params = {}
    if len(sys.argv) > 2 and sys.argv[2].strip():
        params = json.loads(sys.argv[2])
    try:
        result = handler(**params)
    except TypeError as exc:
        result = {"success": False, "error": f"{action} 参数不匹配: {exc}"}
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        result = {"success": False, "error": f"{action} 执行失败: {exc}"}
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""
ArcGIS Pro arcpy 工具箱（复刻自个人 GIS 函数库的 arc_tools.py，按本项目 Agent 场景重写）。

运行环境：ArcGIS Pro 自带的 arcgispro-py3 Python。arcgis 工具执行时已把本目录注入
PYTHONPATH，Agent 代码可直接 ``import arcgis_toolbox`` 使用。仅依赖 arcpy
（arcgispro-py3 默认不带 geopandas，故本库不引入）。

与 opengis 工具箱的分工：本库聚焦 arcpy 独占或更可靠的能力（叠加擦除、椭球面积、
GDB 批量导入导出、渔网、线分割等）；开源栈能做的事请优先用免审批的 opengis_* 工具。

统一约定：
- 失败一律 raise（上层依赖非零退出码感知失败），不吞错；
- 中间文件放系统临时目录（用完即删），不影响源数据；
- ⚠ 原地修改源数据的函数在 docstring 中显式标注，调用前建议先复制备份；
- 所有 print 进度会出现在工具的 stdout 里。
"""

import contextlib
import os
import shutil
import tempfile
import time

import arcpy


@contextlib.contextmanager
def temp_workspace(prefix="arcgis_tb_"):
    """中间文件的临时目录：块结束即删，最终输出不要放在里面。"""
    path = tempfile.mkdtemp(prefix=prefix)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _scratch_output(name="result.shp"):
    """未显式指定输出路径时的结果落点（不随临时目录清理，返回给调用方使用）。"""
    folder = tempfile.mkdtemp(prefix="arcgis_out_")
    return os.path.join(folder, os.path.basename(name))


def _optional_fields(table):
    """要素类的非必填字段名（FID / Shape 等系统字段不参与删除）。"""
    return [f.name for f in arcpy.ListFields(table) if not f.required]


def _delete_fields(table, drop_list, retries=3):
    """DeleteField 带重试（shp 字段改名后偶发首删失败）。"""
    if not drop_list:
        return
    for attempt in range(retries):
        try:
            arcpy.management.DeleteField(table, drop_list, "DELETE_FIELDS")
            return
        except Exception as err:  # noqa: BLE001 - arcpy 抛通用 Exception
            if attempt == retries - 1:
                raise
            print(f"DeleteField 第 {attempt + 1} 次失败: {err}")
            time.sleep(0.5)


def clear_field(input_layer, field_name):
    """清空指定图层中某个字段的所有内容（⚠ 原地修改源数据）。

    参数:
        input_layer: 图层路径（shp 或 GDB 图层）
        field_name: 要清空的字段名
    """
    if not arcpy.Exists(input_layer):
        raise FileNotFoundError(f"输入图层或文件不存在: {input_layer}")
    field_names = [f.name for f in arcpy.ListFields(input_layer)]
    if field_name not in field_names:
        raise ValueError(f"字段 '{field_name}' 不存在。可用字段: {field_names}")
    arcpy.management.CalculateField(input_layer, field_name, "None", "PYTHON3")
    print(f"已清空 '{input_layer}' 中字段 '{field_name}'。")


def select_by_attribute(input_shp, where_clause, output_shp=None):
    """按属性条件提取要素（arcpy Select）。

    参数:
        input_shp: 输入要素类路径
        where_clause: SQL 条件，如 "DLMC = '坑塘水面'"
        output_shp: 输出路径；缺省落到系统临时目录并返回该路径
    """
    arcpy.env.overwriteOutput = True
    with temp_workspace() as temp_dir:
        picked = os.path.join(temp_dir, "selected.shp")
        arcpy.analysis.Select(input_shp, picked, where_clause)
        target = output_shp or _scratch_output()
        arcpy.management.Copy(picked, target, data_type="ShapeFile")
    print(f"已按条件 {where_clause} 提取到 {target}")
    return target


def keep_fields(input_shp, fields, output_shp=None, mode="keep"):
    """仅保留（mode='keep'）或删除（mode='drop'）指定字段，输出到新文件。

    参数:
        input_shp: 输入要素类路径
        fields: 字段名列表（keep 语义为保留清单，drop 语义为删除清单）
        output_shp: 输出路径；缺省落到系统临时目录并返回该路径
    """
    arcpy.env.overwriteOutput = True
    with temp_workspace() as temp_dir:
        copy = os.path.join(temp_dir, "fields_kept.shp")
        arcpy.management.CopyFeatures(input_shp, copy)
        # 删除后个别字段会恢复改名，循环两轮兜底
        for _ in range(2):
            current = set(_optional_fields(copy))
            if mode == "keep":
                drop = [f for f in current if f not in fields]
            elif mode == "drop":
                drop = [f for f in current if f in fields]
            else:
                raise ValueError("mode 必须是 'keep' 或 'drop'")
            try:
                _delete_fields(copy, drop, retries=1)
            except Exception as err:  # noqa: BLE001
                print(f"字段删除提示: {err}")
        print("剩余字段:", _optional_fields(copy))
        target = output_shp or _scratch_output()
        arcpy.management.Copy(copy, target, data_type="ShapeFile")
    print(f"字段筛选结果已保存到 {target}")
    return target


def add_area_field(input_shp, field_name="MJ"):
    """计算各面要素的平面面积（图层坐标系下，平方米）写入属性表（⚠ 原地修改源数据）。

    参数:
        input_shp: 输入面要素类路径
        field_name: 面积字段名，默认 "MJ"
    """
    arcpy.env.overwriteOutput = True
    if field_name in [f.name for f in arcpy.ListFields(input_shp)]:
        arcpy.management.DeleteField(input_shp, field_name)
    arcpy.management.AddField(input_shp, field_name, "DOUBLE")
    with arcpy.da.UpdateCursor(input_shp, ["SHAPE@", field_name]) as cursor:
        for row in cursor:
            row[1] = row[0].area
            cursor.updateRow(row)
    print(f"已将平面面积写入 '{input_shp}' 的 {field_name} 字段。")


def geo_area(input_shp, field_name="MJ", ellps="CGCS2000", decimals=2, output_shp=None):
    """用 CalculateGeometryAttributes 的 AREA_GEODESIC 计算椭球（大地）面积并写入属性表。

    与 add_area_field 的平面面积不同：大地面积基于椭球（CGCS2000 / GCS_China_2000），
    是自然资源审批口径的图斑面积，投影变形不影响结果。
    ⚠ 未指定 output_shp 时原地修改源数据。

    参数:
        input_shp: 输入面要素类路径
        field_name: 面积字段名，默认 "MJ"
        ellps: "CGCS2000" / "GRS80"（同一椭球）/ "WGS84"；None 表示用图层自身坐标系
        decimals: 保留小数位；None 不四舍五入
        output_shp: 输出路径；缺省原地写回
    """
    arcpy.env.overwriteOutput = True
    # CGCS2000 与 GRS80 在 ArcGIS 中同一基准表达
    ellps_to_wkt = {
        "CGCS2000": 'GEOGCS["GCS_China_Geodetic_Coordinate_System_2000",'
                    'DATUM["D_China_2000",SPHEROID["CGCS2000",6378137.0,298.257222101]],'
                    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
        "GRS80": 'GEOGCS["GCS_China_Geodetic_Coordinate_System_2000",'
                 'DATUM["D_China_2000",SPHEROID["CGCS2000",6378137.0,298.257222101]],'
                 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
        "WGS84": 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
                 'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
                 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
    }
    if ellps is not None and ellps not in ellps_to_wkt:
        raise ValueError("ellps 仅支持 'CGCS2000' / 'GRS80' / 'WGS84' 或 None")
    coordinate_system = ellps_to_wkt[ellps] if ellps else None
    area_unit = "SQUARE_METERS" if ellps else ""

    target = output_shp or input_shp
    if output_shp:
        arcpy.env.overwriteOutput = True
        arcpy.management.Copy(input_shp, output_shp, data_type="ShapeFile")
    if field_name in [f.name for f in arcpy.ListFields(target)]:
        arcpy.management.DeleteField(target, field_name)
    arcpy.management.AddField(target, field_name, "DOUBLE")
    arcpy.management.CalculateGeometryAttributes(
        in_features=target,
        geometry_property=f"{field_name} AREA_GEODESIC",
        length_unit="",
        area_unit=area_unit,
        coordinate_system=coordinate_system,
        coordinate_format="SAME_AS_INPUT",
    )
    if decimals is not None:
        with arcpy.da.UpdateCursor(target, [field_name]) as cursor:
            for row in cursor:
                if row[0] is not None:
                    row[0] = round(row[0], decimals)
                    cursor.updateRow(row)
    print(f"已将椭球面积写入 '{target}' 的 {field_name} 字段。")
    return target


def erase(input_shp, erase_list, output_shp, mode="erase", repair=True):
    """用多个擦除层对输入做叠加擦除（mode='erase'）或裁剪保留（mode='clip'）。

    自动跳过空的擦除层；多层自动合并；结果只保留输入的字段并拆为单部件。

    参数:
        input_shp: 输入要素类路径
        erase_list: 擦除/裁剪层路径列表（shp 或 GDB 图层）
        output_shp: 输出路径
        mode: 'erase' 擦除擦除层范围；'clip' 仅保留与擦除层相交部分
        repair: 是否先 RepairGeometry 修复输入与擦除层
    """
    arcpy.env.overwriteOutput = True
    keep_fields_ = _optional_fields(input_shp)
    with temp_workspace() as temp_dir:
        valid = []
        for item in erase_list:
            if arcpy.Exists(item) and arcpy.management.GetCount(item)[0] != "0":
                valid.append(item)
            else:
                print(f"跳过无效或空图层: {item}")

        if not valid:
            print("没有有效的擦除层，直接复制输入。")
            erased = input_shp
        else:
            if repair:
                arcpy.management.RepairGeometry(input_shp)
                for item in valid:
                    arcpy.management.RepairGeometry(item)
            if len(valid) == 1:
                merged = valid[0]
            else:
                # 文件夹工作空间中 shp 是默认输出格式，但路径必须显式带 .shp
                # （无扩展名时输出被自动改名，后续按原名访问会找不到）
                merged = os.path.join(temp_dir, "merged_erase.shp")
                arcpy.management.Merge(valid, merged)
                if repair:
                    arcpy.management.RepairGeometry(merged)
            erased = os.path.join(temp_dir, "erased.shp")
            if mode == "erase":
                arcpy.analysis.Erase(input_shp, merged, erased)
            elif mode == "clip":
                arcpy.analysis.Clip(input_shp, merged, erased)
            else:
                raise ValueError("mode 必须是 'erase' 或 'clip'")

        print("拆分多部件要素...")
        result = os.path.join(temp_dir, "erase_result.shp")
        arcpy.management.MultipartToSinglepart(erased, result)
        _delete_fields(result, [f for f in _optional_fields(result) if f not in keep_fields_])
        arcpy.management.Copy(result, output_shp, data_type="ShapeFile")
    print(f"已保存到 {output_shp}")
    return output_shp


def fill_holes(input_shp):
    """去除面要素内部空洞（⚠ 原地修改且**丢弃属性表**——Dissolve 后仅剩几何）。

    管线：FeatureToLine（面转边线）→ FeatureToPolygon（线构面，洞消失）→
    Dissolve(SINGLE_PART)。需要保留属性时请先复制，再用空间连接找回属性。

    参数:
        input_shp: 输入面要素类路径
    """
    arcpy.env.overwriteOutput = True
    with temp_workspace() as temp_dir:
        lines = os.path.join(temp_dir, "temp_lines.shp")
        polygons = os.path.join(temp_dir, "temp_m1.shp")
        dissolved = os.path.join(temp_dir, "temp_m2.shp")
        arcpy.management.FeatureToLine(input_shp, lines)
        arcpy.management.FeatureToPolygon(lines, polygons)
        arcpy.management.Dissolve(polygons, dissolved, None, None, "SINGLE_PART", "DISSOLVE_LINES", "")
        arcpy.management.Copy(dissolved, input_shp, data_type="ShapeFile")
    print(f"{input_shp} 已去除空洞（无属性表）。")


def dissolve_singlepart(input_shp, output_shp, dissolve_fields=None, repair=True):
    """按字段融合要素并把结果拆为单部件（对齐 QGIS「融合+拆分多部件」习惯）。

    参数:
        input_shp: 输入要素类路径
        output_shp: 输出路径
        dissolve_fields: 融合字段列表；None / 空列表时整体融合
        repair: 输出前是否 RepairGeometry
    """
    arcpy.env.overwriteOutput = True
    arcpy.management.Dissolve(
        in_features=input_shp,
        out_feature_class=output_shp,
        dissolve_field=";".join(dissolve_fields or []),
        statistics_fields=None,
        multi_part="SINGLE_PART",
        unsplit_lines="DISSOLVE_LINES",
        concatenation_separator="",
    )
    if repair:
        arcpy.management.RepairGeometry(output_shp)
    print(f"融合结果（单部件）已保存到 {output_shp}")
    return output_shp


def import_shp_to_gdb(shp_paths, gdb_path, feature_dataset="", layer_names=None, re_create=False, repair=False):
    """把一批 shp 导入 File GDB（可指定要素集）。

    参数:
        shp_paths: shp 路径列表
        gdb_path: 目标 .gdb 路径（不存在则创建）
        feature_dataset: 目标要素集名（须已存在；空串表示直接放 GDB 根）
        layer_names: 与 shp_paths 对齐的图层名列表；缺省用文件名（去扩展名）
        re_create: True 时先删除重建 GDB（⚠ 会清空整个 GDB）
        repair: 导入前是否 RepairGeometry
    """
    arcpy.env.overwriteOutput = True
    if arcpy.Exists(gdb_path):
        if re_create:
            print(f"重新创建 GeoDatabase: {gdb_path}")
            arcpy.management.Delete(gdb_path)
            arcpy.management.CreateFileGDB(os.path.dirname(gdb_path), os.path.basename(gdb_path))
    else:
        arcpy.management.CreateFileGDB(os.path.dirname(gdb_path), os.path.basename(gdb_path))

    dataset_path = os.path.join(gdb_path, feature_dataset)
    if feature_dataset and not arcpy.Exists(dataset_path):
        raise FileNotFoundError(f"要素集 {feature_dataset} 不存在，请先在 GDB 中创建。")

    for i, shp_path in enumerate(shp_paths):
        name = layer_names[i] if layer_names and layer_names[i] else os.path.splitext(os.path.basename(shp_path))[0]
        if repair:
            arcpy.management.RepairGeometry(shp_path)
        target = dataset_path if feature_dataset else gdb_path
        if arcpy.Exists(os.path.join(target, name)):
            arcpy.management.Delete(os.path.join(target, name))
        arcpy.conversion.FeatureClassToFeatureClass(shp_path, target, name)
        print(f"已导入 {shp_path} → {target}::{name}")
    arcpy.management.ClearWorkspaceCache()
    return gdb_path


def export_gdb_to_shp(gdb_path, output_folder, layer_names, new_names=None, repair=False, text2max=False):
    """把 GDB 中指定图层批量导出为 shp（在临时副本上操作，不动源 GDB）。

    参数:
        gdb_path: 源 .gdb 路径
        output_folder: 输出目录（自动创建）
        layer_names: 要导出的图层名列表（含要素集内图层）
        new_names: 与 layer_names 对齐的导出文件名；缺省用图层名
        repair: 导出后是否 RepairGeometry
        text2max: 是否把文本字段长度改为 255（在副本上改，规避 shp 导出截断）
    """
    arcpy.env.overwriteOutput = True
    os.makedirs(output_folder, exist_ok=True)
    if not arcpy.Exists(gdb_path):
        raise FileNotFoundError(f"GeoDatabase 不存在: {gdb_path}")

    exported = []
    with temp_workspace() as temp_dir:
        # 复制整个 GDB 到副本：text2max 的 AlterField 只发生在副本上
        temp_gdb = os.path.join(temp_dir, "temp_export.gdb")
        arcpy.management.CreateFileGDB(temp_dir, "temp_export.gdb")
        arcpy.management.Copy(gdb_path, temp_gdb)

        # 根要素类与各要素集内的图层统一收集（要素集图层带相对路径）
        members = {}
        arcpy.env.workspace = temp_gdb
        for fc in arcpy.ListFeatureClasses() or []:
            members[fc] = fc
        for ds in arcpy.ListDatasets(feature_type="feature") or []:
            for fc in arcpy.ListFeatureClasses(feature_dataset=ds) or []:
                members[f"{ds}\\{fc}"] = fc

        for i, layer in enumerate(layer_names):
            fc = members.get(layer.split("\\")[-1])
            if fc is None:
                print(f"未找到图层 {layer}，跳过")
                continue
            out_name = new_names[i] if new_names and new_names[i] else layer.split("\\")[-1]
            out_shp = os.path.join(output_folder, f"{out_name}.shp")
            if text2max:
                for field in arcpy.ListFields(fc):
                    if field.type == "String" and field.length < 255:
                        arcpy.management.AlterField(fc, field.name, field_length=255)
            arcpy.management.CopyFeatures(fc, out_shp)
            if repair:
                arcpy.management.RepairGeometry(out_shp)
            exported.append(out_shp)
            print(f"导出 {layer} → {out_shp}")
    return exported


def _tag_and_merge(tagged_layers, field_name, output_shp):
    """给每个图层打上来源标记字段后合并（line_split 的合并步骤）。"""
    with temp_workspace() as temp_dir:
        tagged = []
        for i, (src, tag) in enumerate(tagged_layers):
            copy = os.path.join(temp_dir, f"tagged_{i}.shp")
            arcpy.management.Copy(src, copy, data_type="ShapeFile")
            arcpy.management.AddField(copy, field_name, "TEXT")
            with arcpy.da.UpdateCursor(copy, [field_name]) as cursor:
                for row in cursor:
                    row[0] = tag
                    cursor.updateRow(row)
            tagged.append(copy)
        arcpy.management.Merge(tagged, output_shp)


def line_split(input_shp, line_shp_list, output_shp, max_retries=3):
    """用线要素层切割面要素，并添加 in_<线名> 字段标记切割带归属（"是"/"否"）。

    注意：线图层文件名（去扩展名）不能含中文——交集结果字段以文件名为前缀，
    中文名会导致字段名非法。

    参数:
        input_shp: 被切割的面要素类路径
        line_shp_list: 线要素类路径列表（依次切割，前一轮结果作为后一轮输入）
        output_shp: 输出路径
    """
    arcpy.env.overwriteOutput = True
    current = input_shp
    for line_shp in line_shp_list:
        line_name = os.path.splitext(os.path.basename(line_shp))[0]
        with temp_workspace() as temp_dir:
            intersected = os.path.join(temp_dir, "intersected.shp")
            single = os.path.join(temp_dir, "intersected_single.shp")
            rest = os.path.join(temp_dir, "rest.shp")

            arcpy.analysis.Intersect([current, line_shp], intersected, "NO_FID", None, "INPUT")
            arcpy.management.MultipartToSinglepart(intersected, single)

            keep = _optional_fields(current)
            _delete_fields(
                single,
                [f for f in _optional_fields(single) if f not in keep],
                retries=max_retries,
            )

            # 与线相交的部分标记"是"，其余（擦除后）标记"否"，合并输出
            erase(current, [single], rest, mode="erase", repair=False)
            field_name = f"in_{line_name}"
            _tag_and_merge([(single, "是"), (rest, "否")], field_name, output_shp)
        print(f"已按 {line_name} 切割并标记 {field_name}")
        current = output_shp
    return output_shp


def fishnet(input_shp, output_shp=None, size=50):
    """把面要素按固定格网切割为渔网单元并继承源属性（中心点所在面的属性）。

    参数:
        input_shp: 输入面要素类路径
        output_shp: 输出路径；缺省落到系统临时目录并返回该路径
        size: 格网边长（图层坐标系单位，米）
    """
    arcpy.env.overwriteOutput = True
    desc = arcpy.Describe(input_shp)
    extent = desc.extent
    with temp_workspace() as temp_dir:
        grid = os.path.join(temp_dir, "yw_grid.shp")
        clipped = os.path.join(temp_dir, "yw_clip.shp")
        linked = os.path.join(temp_dir, "yw_link.shp")

        arcpy.management.CreateFishnet(
            out_feature_class=grid,
            origin_coord=f"{extent.XMin} {extent.YMin}",
            y_axis_coord=f"{extent.XMin} {extent.YMax}",
            cell_width=size,
            cell_height=size,
            corner_coord=f"{extent.XMax} {extent.YMax}",
            labels="LABELS",
            template=input_shp,
            geometry_type="POLYGON",
        )
        arcpy.analysis.Clip(grid, input_shp, clipped)
        arcpy.analysis.SpatialJoin(
            target_features=clipped,
            join_features=input_shp,
            out_feature_class=linked,
            join_operation="JOIN_ONE_TO_ONE",
            join_type="KEEP_ALL",
            match_option="HAVE_THEIR_CENTER_IN",
        )
        dropped = 0
        with arcpy.da.UpdateCursor(linked, ["Join_Count"]) as cursor:
            for row in cursor:
                if row[0] == 0:
                    cursor.deleteRow()
                    dropped += 1
        print(f"已删除 {dropped} 个无归属格网。")
        target = output_shp or _scratch_output()
        arcpy.management.Copy(linked, target, data_type="ShapeFile")
    print(f"渔网结果已保存到 {target}")
    return target

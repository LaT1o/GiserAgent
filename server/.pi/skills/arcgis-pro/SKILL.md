---
name: arcgis-pro
description: 需要本机 ArcGIS Pro / arcpy 能力时使用。覆盖叠加擦除与裁剪（多层限制线扣除）、CGCS2000 椭球（大地）面积、GDB 批量导入导出（含字段长度 255 化）、渔网分割、线分割地块并标记归属、面去空洞、按字段融合拆单部件、字段清空与筛选。当用户提到 arcpy、ArcGIS、擦除、扣除、叠加分析、椭球面积、大地面积、图斑面积、渔网、格网、线分割、红线切割、GDB 导入导出、去空洞时优先使用本技能。
---

# ArcGIS Pro 工具箱（arcgis 工具 + arcgis_toolbox 函数库）

## 什么时候用 arcgis（先读这节）

GIS 能力分三档，**从上往下依次考虑**：

| 优先级 | 工具 | 审批 | 适用 |
| --- | --- | --- | --- |
| 1 | `opengis_*`（六个结构化动作） | 免审批 | 元信息 / schema 对齐 / 格式互转 / 重投影 / 矢量裁剪 / GDB 别名 |
| 2 | `opengis`（便携 Python 逃生舱） | 需审批 | 开源栈任意代码：geopandas / shapely / rasterio 分析、缓冲区、栅格 |
| 3 | `arcgis`（ArcGIS Pro 的 arcpy） | 需审批 | **Pro 独占或更可靠**：椭球面积（审批口径）、多层擦除、GDB 批量导入导出、渔网、线分割、拓扑、网络分析 |

`arcgis` 运行在**本机 ArcGIS Pro 自带的 Python（arcgispro-py3）**里，与便携 Python
互相看不到对方的库（arcgispro-py3 没有 geopandas，便携 Python 没有 arcpy）。
执行前确认：本机已安装 ArcGIS Pro 且许可可用；需要扩展模块的功能
（如 Spatial Analyst）先 `arcpy.CheckOutExtension("Spatial")`。

`arcgis` 工具执行时已把工具箱目录注入 `PYTHONPATH`，代码里**直接 import**：

```python
import arcgis_toolbox as at
at.erase("input.shp", ["限制1.shp", "限制2.shp"], "output.shp")   # 多层擦除
```

## arcgis_toolbox 函数清单

| 函数 | 用途 | 原地修改 |
| --- | --- | --- |
| `erase(input, erase_list, output, mode, repair)` | 多层擦除（`erase`）或裁剪（`clip`），自动合并擦除层、只保留输入字段、拆单部件 | 否 |
| `geo_area(input, field_name, ellps, decimals, output_shp)` | 椭球（大地）面积入表，默认 CGCS2000 平方米，自然资源审批口径 | 未给 output 时是 |
| `add_area_field(input, field_name)` | 平面面积（图层坐标系）入表 | 是 |
| `dissolve_singlepart(input, output, dissolve_fields, repair)` | 按字段融合并拆单部件 | 否 |
| `line_split(input, line_list, output)` | 线层依次切割面层，加 `in_<线名>` 字段标记归属（是/否） | 否 |
| `fishnet(input, output, size)` | 面要素渔网化并继承属性（中心点归属） | 否 |
| `fill_holes(input)` | 面去空洞（⚠ 丢属性表，仅剩几何） | 是 |
| `select_by_attribute(input, where_clause, output)` | 按属性条件提取要素 | 否 |
| `keep_fields(input, fields, output, mode)` | 字段筛选（keep 保留清单 / drop 删除清单） | 否 |
| `clear_field(input_layer, field_name)` | 清空某字段全部值 | 是 |
| `import_shp_to_gdb(shp_paths, gdb_path, ...)` | shp 批量导入 GDB（要素集 / 重建 / 修复） | 视参数 |
| `export_gdb_to_shp(gdb_path, folder, layers, ...)` | GDB 批量导出 shp（副本上 `text2max` 字段 255 化） | 否 |

标注「原地修改」的三个函数（`geo_area` 缺省、`add_area_field`、`fill_holes`、`clear_field`）
会改写源数据——**先复制备份再调用**：

```python
import shutil, arcgis_toolbox as at
shutil.copy("地块.shp", "地块_备份.shp")
at.add_area_field("地块.shp")            # 平面面积；审批面积用 at.geo_area(...)
```

## 典型用法

```python
# 1. 扣除多条限制线后算椭球面积（村庄规划常用链路）
import arcgis_toolbox as at
at.erase("现状.shp", ["生态红线.shp", "城镇开发边界.shp"], "现状_扣除.shp")
at.geo_area("现状_扣除.shp", field_name="TBMJ", ellps="CGCS2000", decimals=2)

# 2. 道路红线切割地块并标记归属（线文件名不能含中文）
at.line_split("地块.shp", ["道路红线.shp"], "地块_切分.shp")   # 结果带 in_道路红线 字段

# 3. GDB 批量导出并统一文本字段 255 长度
at.export_gdb_to_shp("成果库.gdb", "output/shp", ["CJXZQ", "XZYDYH"], text2max=True)

# 4. 渔网化
at.fishnet("研究区.shp", "研究区_渔网.shp", size=50)
```

## 编写自定义 arcpy 代码的约定

- 结果尽量 `print(json.dumps(...))` 输出摘要（工具会捕获 stdout）；
- 失败直接 raise，不要 try/except 吞错（工具依赖非零退出码）；
- 中间文件用 `arcgis_toolbox.temp_workspace()` 上下文（用完自动删）；
- 中文路径可用（工具已设 `PYTHONUTF8=1`），但 `line_split` 的线图层文件名除外；
- 会话工作目录是 cwd，输出优先写相对路径（如 `output/xxx.shp`）；
- 未检测到 ArcGIS Pro 时工具会直接报错——提示用户安装 ArcGIS Pro 或设置
  `GISER_ARCGIS_PYTHON` 指向 arcgispro-py3 的 python.exe。

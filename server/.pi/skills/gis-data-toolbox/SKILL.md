---
name: gis-data-toolbox
description: 读取与加工矢量数据（尤其 File GDB）时使用。覆盖 GDB 图层清单与图层/字段别名读取、schema 与坐标系解析、属性表结构对齐（re_schema）、格式互转（GDB/SHP/GeoJSON/GPKG/CSV/Excel）、重投影（reproject）、矢量裁剪（clip）、几何运算（缓冲区/融合/合并）、GDB 副本的别名设置，以及把 GDB 图层登记到前端地图。当用户提到 gdb、shp、图层、字段别名、属性表结构、坐标系错位、格式转换、重投影、投影变换、裁剪、缓冲区、融合、合并、数据上图时优先使用本技能。
---

# GIS 数据工具箱（opengis_* 与 map_* 工具族）

数据读写与加工统一走结构化工具，**不要用 `opengis` 逃生舱重复造轮子**；
逃生舱只留给工具箱没有覆盖的长尾分析（缓冲区、叠加、栅格计算、统计建模等）。

## 工具选择

| 目标 | 工具 |
| --- | --- |
| 列 GDB 里有哪些图层、看图层/字段别名、看 schema 与坐标系 | `opengis_describe` |
| 把数据属性表对齐到目标结构（多删缺补、类型对齐） | `opengis_re_schema` |
| 格式互转（GDB↔SHP/GeoJSON/GPKG，属性表→CSV/Excel） | `opengis_convert` |
| 重投影到另一个坐标系（真坐标变换，如投影坐标→经纬度） | `opengis_reproject` |
| 按范围图层裁剪矢量数据（行政区裁地块等） | `opengis_clip` |
| 几何运算：缓冲区 / 融合 / 多图层合并 | `opengis_geometry` |
| 给工作区内的 GDB 副本批量设图层/字段别名 | `opengis_set_alias` |
| 看数据元信息 / 把矢量数据登记到前端地图 | `map_inspect` / `map_add_layer` |
| 已登记图层的显隐、显示名、顺序 | `map_set_layer` / `map_list_layers` |

七个 `opengis_*` 工具都是**免审批**的（安全约束靠路径硬校验，见下），
只有任意 Python 执行工具 `opengis` 需要人工审批。

## 路径约定（重要）

File GDB 必须写成 **`数据库.gdb/图层名`**：

- ✅ `data/村庄规划.gdb/CJXZQ`
- ❌ `data/村庄规划.gdb`（那是数据库，`opengis_describe` 会列出全部图层，`convert` 不接受）

直接对 GDB 调 `geopandas.read_file("x.gdb/图层名")` 会报错，工具内部已做拆分，无需自己处理。
shp / geojson / gpkg 直接给文件路径即可。

相对路径以**会话工作目录**为基准；绝对路径也可用，但必须落在会话绑定的项目/工作区内。

## 六类场景

### 1. 元信息与别名读取

```
opengis_describe(path="data/村庄规划.gdb")                  # 列出所有图层（含图层别名）
opengis_describe(path="data/村庄规划.gdb/CJXZQ")            # 单图层：driver/几何/要素数/EPSG/范围/字段+别名
opengis_describe(path="data/村庄规划.gdb/CJXZQ", with_alias=false)  # 不需要别名时更快
```

返回里重点看：`epsg`（缺失或为常识外的值要警惕坐标系错位）、`fields[].alias`（中文字段名）、
`feature_count`、`bounds`。若 `epsg` 为 null，说明该数据的坐标系无法自动解析，
上图时可能错位，应提示用户确认坐标系。

### 2. 属性表结构对齐（re_schema）

让导出数据的字段与标准图层完全一致，避免跨格式往返后字段漂移。

```
opengis_re_schema(
  input="data/村庄规划.gdb/CJXZQ",
  schema_from="data/村庄规划.gdb/标准图层",   # 参考结构（推荐：同一库里的标准图层）
  output="output/CJXZQ_对齐.shp"
)
```

也可以直接给 schema：

```
opengis_re_schema(
  input="data/村庄规划.gdb/地块",
  schema={"geometry": "Polygon",
          "fields": [{"name": "id", "type": "string"}, {"name": "type", "type": "string"}]}
)
```

语义：目标有而输入没有的字段 → 补空值；输入有而目标没有的 → 删除；同名不同类型 → 按目标类型转换。
`schema_from` 与 `schema` 二选一，都不给则报错。省略 `output` 时写入会话 `output/` 目录（自动带时间戳）。

### 3. 格式互转

```
opengis_convert(input="data/村庄规划.gdb/CJXZQ", output="output/CJXZQ.shp")
opengis_convert(input="data/村庄规划.gdb/CJXZQ", output="output/导出.gdb/CJXZQ")   # GDB→GDB
opengis_convert(input="data/地块.shp", output="output/地块.xlsx")                 # 属性表→Excel
opengis_convert(input="data/道路.shp", output="output/道路.geojson", repair=true)  # 顺带几何修复
```

输出格式由扩展名决定：`.shp` / `.geojson` / `.gpkg` / `.gdb/图层名` / `.csv` / `.xlsx`。
`repair=true` 会先做多部件拆分与几何修复（`make_valid`），适合后续做空间运算前预处理。
导出时**从不覆盖已有数据**：同名文件加 `_1`、`_2`，目标 GDB 内已有同名图层时把图层名改为 `图层_1`。

### 4. 别名设置与 GDB 修复（仅工作区副本）

```
opengis_set_alias(gdb="output/副本.gdb",
                  layer_aliases={"CJXZQ": "村级行政区"},
                  field_aliases={"CJXZQ": {"QSDWMC": "权属单位名称", "DLMC": "地类名称"}})
```

**只能改会话工作区内的 GDB 副本**，工具拒绝写工作区外的源数据；需要保留别名时先
`opengis_convert` 把源库整层导出成工作区内的新 GDB 再设置。
别名读写走 GDAL(osgeo) 的 GDB_Items Definition XML 改写（标准便携运行时已装 GDAL 3.13，
见 `scripts/setup-python.md`）；`set_alias` 默认同时清理 ArcGIS 不认的
Length/Precision/Scale 节点（`fix=false` 可关），只清理不设别名用 `fix_gdb` 动作。
万一运行时不带 GDAL，写别名/修复会返回明确错误提示——别名**读取**不受影响。

### 5. 重投影（reproject）

```
opengis_reproject(input="data/地块.shp", crs="EPSG:4326", output="output/地块_84.shp")
```

**与 `opengis_convert` 的 crs 参数的区别**（重要）：
- `convert` 的 crs 是**改标注**：数据坐标本来就是那个坐标系，只是标注缺失/错了（如缺 .prj）；
- `reproject` 是**真坐标变换**：几何坐标实际换算（投影坐标 ↔ 经纬度等）。

输入必须有坐标系标注（无标注会报错并提示先用 convert 修正）；返回 `source_epsg` / `epsg`
/ 新坐标系下的 `bounds`，可据此核对变换结果。字段类型与宽度直通保留，不漂移。

### 6. 矢量裁剪（clip）

```
opengis_clip(input="data/全县地块.shp", mask="data/规划范围.shp", output="output/范围内地块.gpkg")
opengis_clip(input="data/村庄规划.gdb/地块", mask="data/边界.gdb/CJXZQ", output="output/地块_村域.shp")
```

- mask 是**任意矢量数据**（面图层常用；只需几何，属性被忽略），支持 `xxx.gdb/图层名`；
- mask 与输入坐标系不同时**自动对齐**（mask 变换到输入坐标系，返回 `mask_aligned: true`）；
- 字段结构沿用输入；完全落在范围外的要素被移除，返回 `features_before` / `feature_count`；
- 输出与输入、mask 相同都会被拒绝（不覆盖任何源数据）。

### 6a. 几何运算（opengis_geometry，operation 路由）

```
opengis_geometry(operation="buffer", input="data/地块.shp", distance=50, output="output/地块_缓冲.shp")
opengis_geometry(operation="dissolve", input="data/地块.shp", by=["地类"], output="output/地类融合.shp")
opengis_geometry(operation="dissolve", input="data/地块.shp", output="output/整体边界.shp")        # 全融合单要素
opengis_geometry(operation="merge", inputs=["data/村A地块.shp", "data/村B地块.shp"], output="output/合并.shp")
```

- **buffer 的 distance 单位随输入坐标系**：投影坐标（如 EPSG:4547）为米，经纬度为度——
  经纬度数据先 `opengis_reproject` 到投影坐标系再缓冲；
- **dissolve** 按 `by` 字段聚合（属性取首值），省略 `by` 全融合为单要素；
- **merge** 纵向拼接多个**同几何类型**图层：字段取并集、缺列补空、CRS 自动对齐到
  首个输入；几何类型不一致会拒绝（先统一几何类型再合并）。

## 安全边界（免审批的前提）

- **绝不修改源数据**：所有写出动作先校验输出路径，输出与任何输入相同则直接拒绝；
  已存在同名文件自动加序号（`_1`、`_2`…），不会静默覆盖。
- **输出必须落在会话绑定的项目/工作区内**，越界报错而不是硬写。
- 每次调用的返回 JSON 会回显 `inputs` / `output`，用于核对实际读写路径。
- 要动「源 GDB 本身」（如就地改别名、修复破损库）时，先把库复制进工作区再操作。

## 长尾能力与毕业流程

结构化工具只覆盖高频操作。**新几何需求按「毕业流程」走**：

1. **先在逃生舱验证**（需审批）：`opengis` 的 PYTHONPATH 已含工具箱，直接复用现成函数：

   ```python
   import opengis_toolbox as ot          # read_vector/write_vector/passthrough_schema 等可直接用
   gdf = ot.read_vector("data/地块.shp")
   # 写新几何函数，print(json.dumps(result)) 输出摘要
   ```

2. **验证稳定后毕业**：把函数加进 `opengis_toolbox.py` 的 `ACTIONS`，并在
   `opengis_geometry` 的 `operation` 枚举扩展（参数同构的几何操作都路由到这一个工具，
   不新建独立工具；参数形态差异大的操作才独立成新工具）。毕业即免审批。

以下需求仍直接用 `opengis` 逃生舱写代码（不必毕业）：

- 空间分析：叠加求交、最近邻、聚类、统计汇总等一次性需求；
- 栅格处理：裁剪、重采样、波段运算、重投影（rasterio）；
- 批量重命名字段等一次性脚本（矢量重投影、裁剪、缓冲、融合、合并已覆盖）。

逃生舱同样受写黑名单约束（`.latio/`、`runtime/`、`.env` 等不可写），
产物请写到工作区目录内，并保持「不改源数据」的原则。

**写代码时注意后端**：geopandas 1.x 默认引擎是 pyogrio，而 pyogrio **不支持 `schema` 参数**
（字段类型不受约束，跨格式往返会漂移）。凡是要控制字段结构/类型的读写，显式指定
`engine="fiona"` 并传 fiona 原生 schema
（`{"geometry": "MultiPolygon", "properties": {"字段": "str" | "int" | "float" | "datetime"}}`）。

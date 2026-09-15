---
name: gis-data-toolbox
description: 读取与加工矢量数据（尤其 File GDB）时使用。覆盖 GDB 图层清单与图层/字段别名读取、schema 与坐标系解析、属性表结构对齐（re_schema）、格式互转（GDB/SHP/GeoJSON/GPKG/CSV/Excel）、重投影（reproject）、矢量裁剪（clip）、GDB 副本的别名设置，以及把 GDB 图层登记到前端地图。当用户提到 gdb、shp、图层、字段别名、属性表结构、坐标系错位、格式转换、重投影、投影变换、裁剪、数据上图时优先使用本技能。
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
| 给工作区内的 GDB 副本批量设图层/字段别名 | `opengis_set_alias` |
| 看数据元信息 / 把矢量数据登记到前端地图 | `map_inspect` / `map_add_layer` |
| 已登记图层的显隐、显示名、顺序 | `map_set_layer` / `map_list_layers` |

六个 `opengis_*` 工具都是**免审批**的（安全约束靠路径硬校验，见下），
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

## 安全边界（免审批的前提）

- **绝不修改源数据**：所有写出动作先校验输出路径，输出与任何输入相同则直接拒绝；
  已存在同名文件自动加序号（`_1`、`_2`…），不会静默覆盖。
- **输出必须落在会话绑定的项目/工作区内**，越界报错而不是硬写。
- 每次调用的返回 JSON 会回显 `inputs` / `output`，用于核对实际读写路径。
- 要动「源 GDB 本身」（如就地改别名、修复破损库）时，先把库复制进工作区再操作。

## 长尾能力

工具箱只有上述结构化动作。以下需求直接用 `opengis` 逃生舱写代码（需审批）：

- 空间分析：缓冲区、叠加求交、溶解聚合、最近邻、聚类、统计汇总；
- 栅格处理：裁剪、重采样、波段运算、重投影（rasterio）；
- 批量重命名字段等一次性脚本（矢量重投影与裁剪已覆盖，见 `opengis_reproject` / `opengis_clip`）。

逃生舱同样受写黑名单约束（`.latio/`、`runtime/`、`.env` 等不可写），
产物请写到工作区目录内，并保持「不改源数据」的原则。

**写代码时注意后端**：geopandas 1.x 默认引擎是 pyogrio，而 pyogrio **不支持 `schema` 参数**
（字段类型不受约束，跨格式往返会漂移）。凡是要控制字段结构/类型的读写，显式指定
`engine="fiona"` 并传 fiona 原生 schema
（`{"geometry": "MultiPolygon", "properties": {"字段": "str" | "int" | "float" | "datetime"}}`）。

# 便携 Python 运行时重建指南

项目使用**自包含的便携 Python**（`runtime/python/`）驱动 Agent 的代码执行（`python` 工具）
与默认 GIS 能力。该目录体积大、可随时重建，已加入 `.gitignore`。

首次使用或目录损坏时按以下步骤重建（Windows）。

## 1. 下载并解压 CPython embeddable

来源为华为开源镜像（同步 python.org 官方 FTP），版本 **3.12.10，Windows x86_64**：

```bash
cd <项目根>
mkdir -p runtime/python
curl -L -o /tmp/python-embed.zip \
  https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-embed-amd64.zip
# Git Bash 下用 Windows 系统 bsdtar 解压（GNU tar 不识别 zip）：
MSYS_NO_PATHCONV=1 /c/Windows/System32/tar.exe \
  -xf "$(cygpath -w /tmp/python-embed.zip)" -C "$(cygpath -w runtime/python)"
runtime/python/python.exe --version   # 应输出 Python 3.12.10
```

> 备选源：`https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip`

## 2. 启用 site-packages 并安装 pip

embeddable 版默认关闭 site-packages 机制，需先修改 `runtime/python/python312._pth`，
将 `#import site` 一行取消注释（改为 `import site`），然后：

```bash
curl -L -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py
runtime/python/python.exe /tmp/get-pip.py --no-warn-script-location \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 3. 安装 GIS 库

```bash
runtime/python/python.exe -m pip install --no-warn-script-location \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  geopandas shapely fiona pyogrio pyproj rasterio pandas numpy openpyxl chardet
```

已验证可用的版本组合（2026-09）：

| 库 | 版本 |
|---|---|
| geopandas | 1.1.4 |
| shapely | 2.1.2 |
| fiona | 1.10.1 |
| pyogrio | 0.13.0 |
| pyproj | 3.8.0 |
| rasterio | 1.5.1 |
| pandas | 3.0.5 |
| numpy | 2.5.3 |
| openpyxl | 3.1.5 |
| chardet | 7.6.0 |
| GDAL (osgeo) | 3.13.3（第三方 wheel，见下） |

`chardet` 供属性表字节列解码使用（`opengis_toolbox.py` 的编码兜底）。

> **后端约定**：工具箱的读写统一显式指定 `engine="fiona"`。geopandas 1.x 的默认引擎已是
> pyogrio，而 **pyogrio 不支持 `schema` 参数**——属性表字段类型不受约束，跨格式往返会漂移
> （实测 int 字段被写成 Float64）。需要 schema 保真的场景必须走 fiona。

**关于独立 GDAL（`from osgeo import gdal`）**：PyPI 上的 `GDAL` 只有源码包（Windows 无官方
wheel，源码构建失败），但可用第三方构建的 wheel 补上：

```bash
# 版本号与 python 标签按需替换（本机 CPython 3.12）
curl -L -o /tmp/gdal.whl \
  https://github.com/cgohlke/geospatial-wheels/releases/download/v2026.8.20/gdal-3.13.3-cp312-cp312-win_amd64.whl
runtime/python/python.exe -m pip install --no-warn-script-location --no-deps /tmp/gdal.whl
runtime/python/python.exe -c "from osgeo import gdal; print(gdal.__version__)"
```

本运行时**已安装 GDAL 3.13.3 的 Python 绑定**（`from osgeo import gdal` 可用）。
工具箱中以下能力**依赖它**：GDB 别名读写与 `fix_gdb`（改写 GDB_Items 的 Definition XML）。
重建 `runtime/` 时按上面的命令补装即可；未装时工具箱会返回「需要 GDAL(osgeo) 绑定」的
明确提示，其余能力不受影响——矢量读写由 fiona / pyogrio / rasterio 自带的内嵌 GDAL 运行时
承担（KML 读取即走 pyogrio 兜底，fiona 不含 KML 驱动）。
也可改用 `GISER_PYTHON` 指向含 osgeo 的本机环境。

## 4. 验证

```bash
runtime/python/python.exe -c "import geopandas, shapely, fiona, pyproj, rasterio; print('GIS 栈 OK')"
```

## 5. 与 Agent 的对接

- 路径约定：`server/src/config.ts` 默认取 `<项目根>/runtime/python/python.exe`；
  可用环境变量 `GISER_PYTHON` 覆盖（见 `server/.env.example`）。
- 文件缺失且未设置 `GISER_PYTHON` 时，server 启动即报错并指向本文档。
- 测试数据：`runtime/python/python.exe server/scripts/make-test-data.py`
  生成 `workspace/test-data/sample_fields.shp`（56 个地块，EPSG:4547）。

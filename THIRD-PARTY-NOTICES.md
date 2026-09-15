# 第三方组件许可声明

本项目以 [Apache-2.0](LICENSE) 许可发布。本文件列出随源码或安装包分发的关键第三方组件及其许可；各组件的完整许可文本以其包内文件与本声明为准。

## pi（MIT）

本项目的 Agent 运行时基于 [pi](https://github.com/earendil-works/pi)（作者 Mario Zechner / Earendil Works）构建，并移植了其官方示例仓库中的部分示例代码（经适配去 TUI 化）。

随本项目分发（安装包内 `node_modules`）的 pi 系列包：

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-telemetry`
- `@earendil-works/chord`

以上包以 MIT 许可发布（`package.json` 的 `license` 字段与官方仓库声明；npm 发布包内未附带独立许可证文本文件，本声明即为其版权与许可信息的随附保留）：

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 注：上方版权年份以 pi 官方仓库实际声明为准；如与其仓库 LICENSE 不一致，以官方仓库为准。

## 其他依赖

其余 npm 依赖（fastify、react、electron、vite、OpenLayers、proj4 等）与便携 Python 运行时内的开源 GIS 库栈（geopandas、shapely、fiona、pyproj、rasterio、GDAL/GEOS/PROJ 系）各自以自己的开源许可发布，许可文本见各包内文件或官方仓库；安装包分发时随 `node_modules` / `site-packages` 原样保留。

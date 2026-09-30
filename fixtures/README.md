# ParaLens feasibility fixtures

本目录只保存可再分发的测试样本或样本清单，不保存用户 Zotero 数据。

## 当前本地基线（不纳入 Git）

- 文件：本地 Zotero 附件 PDF（不记录个人文件路径）
- 类型：数字原生 PDF，15 页，有文本层
- SHA-256：`568eeb6eec6a7e555566c3a90471c4dfc45f94e7e60bb0fc9841520085c32390`
- 许可：论文来源和再分发许可尚未核实，不复制到仓库
- 用途：A1/A2 本机基线，不作为 CI fixture
## 待补样本

按 `docs/实施规划.md` A1 要求，后续应加入开放许可或自行生成样本，至少覆盖单栏、双栏、跨页段落、公式、图注、CropBox/Rotate，以及文本层缺失/扫描件（仅验证拒绝或提示 OCR）。每个样本需记录来源/许可证、页数、SHA-256、文本层和预期几何特征。

## 合成双段映射

`two-paragraphs.mapping.v1.json` 来自本地自动生成英文双段 PDF 经 BabelDOC 0.5.20 和回环模拟 API 翻译后输出的 `mapping.v1`。为测试而替换了源/译 PDF 摘要、附件 key 与创建时间，不含用户 PDF 或 API 密钥；Node 测试使用它验证两段文本的双向命中和 Reader 高亮切换。

## 合成两页试译样本

`gui-smoke-two-pages-en.pdf` 由 `scripts/local-api-translation-smoke.py --two-pages` 用 PyMuPDF 自行生成（英文河流/海洋两页，无第三方内容），SHA-256：`7b7c05b126dfc668b9f244fdd2f67b6d151a9641196d288d0ee9b15dd9dc0fd1`。每页有可选文本层与足够的正文，供两页的真实 API 试译与跨页 Reader 映射验证；测试产物和凭据不加入仓库。

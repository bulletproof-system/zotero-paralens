# 源码获取、构建与分发

本项目的许可全文见 [LICENSE](../LICENSE)，第三方材料见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。以下是工程分发说明，
不代表对所有依赖、模型或字体的全面法律合规认证。

## 对应版本的源码

正式 Release 应同时提供：

- `zotero-paralens.xpi`；
- `zotero-paralens-<版本>-source.tar.gz`：发布标签对应的 Git 跟踪文件；
- 同名 `.sha256`：源码附件的校验值；
- 同名 `.json`：版本、标签及提交哈希。

源码附件保留 TypeScript/Python 源码、资源、构建与安装脚本、npm 锁文件、
许可文本和本说明，而不是只提供编译后的 JavaScript。它不包含本机 `.env`、
凭据、Zotero profile、Git 历史、node_modules、.venv 或私有翻译样本。

Release 工作流在插件发布成功后，通过 `git archive` 生成同一标签的源码附件。
附件上传失败会令整个 Release 工作流失败；此时插件可能已经上传，维护者必须
补齐附件，不能将该次分发称为材料齐全。

仓库公开后也可从对应标签或提交下载 GitHub 自动生成的源码压缩包。
**若仓库仍为 private，未授权的收件人无法使用这些链接。** 发布者应在向公众
分发前确保源码入口实际可访问，或为收件人提供等效的源码获取方式。
不要只给出 main 分支链接，也不要在已发布后移动标签。

本次新增的分发规则不追溯修改旧版 XPI 或旧 Release。旧附件缺失的材料必须
另行补发或通过包含修复的新版本处理；本地修改不会自动改变远端附件。

## 构建插件

以要构建的实际版本替换示例中的 `vX.Y.Z`：

```bash
git clone https://github.com/bulletproof-system/zotero-paralens.git
cd zotero-paralens
git checkout --detach vX.Y.Z
npm ci
npm run build
npm run verify:licenses
```

建议使用 Node.js 24（现有 CI 使用的主版本）及兼容的 npm。
产物位于 `.scaffold/build/zotero-paralens.xpi`。
在 Zotero 插件管理器中选择“从文件安装插件”，安装该文件。
目前构建包含时间戳；本说明不保证字节级可重复构建。

开发者本地未提交的构建不一定等同于包内版本链接指向的已发布源码；
正式分发必须从干净的发布标签构建。

## 后端安装及依赖源码

插件在用户 profile 中部署本仓库的 Python 源文件。
用户明确点击安装后，通过 `uv sync --project <后端目录> --python 3.12`
安装 BabelDOC 0.6.4 及其依赖。启动插件不自动安装后端。

- 本仓库中的 editable worker / adapter 源码位于 `backend/`。
- BabelDOC 对应源码见其 `v0.6.4` 标签，地址列于第三方声明。
- Python 间接依赖没有固定和完成全面审查；单一 BabelDOC 版本不是完整锁文件。
- 如果交付 .venv、wheel 集合、离线安装包或服务端部署，必须另外审查实际解析的
  依赖及原生库，提供适用的许可、对应源码和安装/修改说明。
- 修改 AGPL 软件并提供网络服务时，应按实际适用的 AGPL 条款提供源码入口；
  不应将“独立进程”或“用户自行安装”当成自动免除义务的依据。

## 发布前检查

1. 核对源码标签、package.json 与 package-lock.json 的版本一致。
2. 运行 `npm run lint:check`、`npm run test:unit`、`npm run build`。
3. `npm run verify:licenses` 确认最终 XPI 含许可、原始 MIT 声明和源码入口。
4. 升级 toolkit 后核对许可证快照及新增打包依赖，不能只改版本号。
5. 下载实际 Release 的 XPI、源码和校验值，并以未登录 GitHub 的方式检查源码入口。
6. 模型、OCR、字体和真实文档的再分发授权另行确认。

源码附件也可以从干净的标签手动创建：

```bash
node scripts/create-source-archive.cjs vX.Y.Z
gh release upload vX.Y.Z .scaffold/source/zotero-paralens-X.Y.Z-source.tar.gz .scaffold/source/zotero-paralens-X.Y.Z-source.tar.gz.sha256 .scaffold/source/zotero-paralens-X.Y.Z-source.json --clobber
```

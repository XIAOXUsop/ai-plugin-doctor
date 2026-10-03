# 源码交付与 Windows 复现

## 从源码包开始

源码包面向 Windows x64 / Node.js 24。先解压，在 `ai-plugin-doctor` 目录打开终端。原生组件使用系统 .NET Framework 编译器，`build` 会检查是否可用，缺失时明确失败。源码包不带预编译程序。

```powershell
npm ci --ignore-scripts
npm run build
npm test
node dist/src/cli.js help
node dist/src/cli.js init doctor.yaml
```

最后一条生成本机适用的合成服务样例，不需要模型密钥、不执行模型请求。读取配置诊断见 `docs/配置诊断使用指南.md`；已有服务导入见 `docs/服务导入与路径选择指南.md`。`run` 需要用户自行设置客户端、模型及可用认证，可能产生模型费用。

安装依赖需要网络。如需代理，使用本机实际地址配置当前终端，不把代理地址、凭据或本机配置复制进源码包。`npm ci --ignore-scripts` 不执行依赖安装脚本；构建会显式编译本项目的 Windows 组件。交付验收使用构建后的 CLI；开发入口 `npm run dev` 也必须先构建，才能使用 Windows 进程和文件保护组件。

## 打包与摘要

```powershell
npm run package:source
# 指定一个新的输出路径：
npm run package:source -- releases/source-review.zip
```

打包按代码中的明确文件清单，包含源代码、测试、两个本地 fixture、原生组件源代码、锁文件、必要构建/示例脚本、使用指南和 CI 定义。不包含 `node_modules`、`dist`、`.git`、`.doctor`、本机 `doctor*.yaml`、运行日志、研究依赖、研究记录或认证文件。必要文件缺失或读取到符号链接时失败；不会覆盖已有包或校验文件。

ZIP 使用固定文件顺序、时间与权限，不嵌入本机绝对根路径或当前时间；同一份文件内容在本次 Node 环境重复生成字节相同。源码更改会使摘要变化。旁边的 `.sha256` 是整包摘要，包内 `SOURCE_MANIFEST.json` 记录各文件的长度与 SHA-256，以及清单汇总摘要。

解压后构建，再校验清单：

```powershell
npm run verify:source
```

校验覆盖清单内的源码文件与打包规则；构建或安装生成的目录允许存在。摘要用于完整性检查，不是数字签名；整包校验应与可信来源提供的 `.sha256` 比对。

## CI 与历史材料

Windows CI 定义安装、构建、测试、打包、Windows 原生解压、独立重建和测试，并保存源码包与摘要为运行产物；上传运行产物只发生在实际启动的 GitHub CI 内。本地提供 CI 定义不等于远端已运行。

README 保留项目历史说明，其中 `research/`、历史验收文档和 `runs/` 链接指向原工作区的材料，精简源码包不包含它们，不把这些本机结果冒充为解压后已有结果。解压后应按本指南重新生成证据；用户访谈与试用反馈已移出当前范围。

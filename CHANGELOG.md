# 变更记录

本项目的所有重要变更都记录在这里。

## 1.0.2

修复：代码围栏内的 `#` 行被误认为 Markdown 标题，导致 `organize_tree` 把一片树叶静默切成两半。

- 结构扫描（标题查找、节点边界、待整理计数）现在会跳过 ```` ``` ```` / `~~~` 围栏；
  未闭合的围栏之后一律视为围栏内，宁可少认标题也不误切节点。
- 标题只出现在代码块内时改为**报错**，不再照着搬。
- Markdown 结构操作抽到 `src/markdown.ts`（纯函数），`src/index.ts` 只保留工具注册与 I/O；
  补 `node:test` 回归测试（`pnpm test`）。
- 已知限制：Setext 标题（`标题` + `====`）、4 空格缩进代码块、HTML 注释内的 `#` 仍不识别。

## 1.0.1

首个发布到 npm 的版本（`dsh-knowledge-tree`）。

- 适配 dsh `0.2.0-rc.2`：`peerDependencies` / `devDependencies` 同步到 `^0.2.0-rc.2`。
- 补全 npm 包元数据：`repository` / `homepage` / `bugs` / `keywords` / `engines`。

## 1.0.0

- 改造为可直接安装的 DSH bundle：`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`。
- 四个工具：`append_leaf`、`organize_tree`、`cleanup_organized_leaf`、`update_index`。
- 随包技能：`append-leaf`、`organize-tree`，由配置层里单独一行 `@deepseek-ai/dsh-skill-filesystem` 提供。

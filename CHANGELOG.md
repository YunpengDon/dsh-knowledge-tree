# 变更记录

本项目的所有重要变更都记录在这里。

## 1.1.0

人在环内改为复用 [dsh-hitl](https://github.com/YunpengDon/dsh-hitl) 的决策卡，不再自带确认卡。

- 四个工具落盘前各挂一张卡：`append_leaf` 按 Markdown 渲染正文；`organize_tree` 给出整理之后的整文件 diff；
  `update_index` 给出旧 / 新索引的并排 diff；`cleanup_organized_leaf` 只读展示将被删除的那片叶子原文。
- 卡面规矩：可改的才给输入框（正文、名称、锚点、落点、被搬移的标题），既定对象只读（删除卡整张只读，
  删除与搬移的"知识树文件"只读），预览（diff、将被删除的内容）一律只读；字段顺序先参数、后预览。
- 卡上的预览与落盘共用 `src/markdown.ts` 的同一组纯函数，两者不会跑偏；算不出来时（锚点不存在、叶子不在待整理区、
  文件被删）卡上直接说明原因，而不是弹不出卡或装作没事。
- 配置改为 `config.hitl`：`enabled` / `whenUnavailable` / `countdownSeconds` / `rejectFeedback`。
  旧的 `humanTurn` / `confirm` / `confirmTools` / `feedbackTools` / `confirmTimeoutSeconds` 只警告、不再生效
  （其中 `off` 会映射成 `hitl.enabled: false`）。
- 卡片需要 **dsh-hitl ≥ 0.2.0**：0.2.0 才提供"计算字段"，diff 与删除预览靠它拿到磁盘上的原文。
  `dsh-hitl` 本身仍是**可选**依赖——组合里没有它时四个工具照常工作，只是没有人确认这一环。
- 路径定位抽到 `src/paths.ts`；结构操作新增 `nodeText()`，`update_index` 的补标题规则抽成 `indexFileText()`
  （预览与写入共用）；补 `tests/hitl.test.js`。
- 已知限制：预览读的是弹卡那一刻的文件内容。人在看卡时文件若被别的会话改动，diff 与真正落盘的内容可能不一致——
  HITL 拦的是"调用开始之前"，它不是事务。

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

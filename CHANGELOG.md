# 变更记录

本项目的所有重要变更都记录在这里。

## 1.0.1

首个发布到 npm 的版本（`dsh-knowledge-tree`）。

- 适配 dsh `0.2.0-rc.2`：`peerDependencies` / `devDependencies` 同步到 `^0.2.0-rc.2`。
- 补全 npm 包元数据：`repository` / `homepage` / `bugs` / `keywords` / `engines`。

## 1.0.0

- 改造为可直接安装的 DSH bundle：`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`。
- 四个工具：`append_leaf`、`organize_tree`、`cleanup_organized_leaf`、`update_index`。
- 随包技能：`append-leaf`、`organize-tree`，由配置层里单独一行 `@deepseek-ai/dsh-skill-filesystem` 提供。

# dsh-knowledge-tree

一个「把散落知识捋成自己的教程」的个人知识管理系统。在与 AI 的对话中收集零散知识（树叶），AI 自动归类到知识树，长期积累最终形成个人独有的知识体系。

## 文件结构

```
dsh-knowledge-tree/           # 包名 dsh-knowledge-tree
├── src/
│   └── index.ts              # 全部代码：工具实现 + 插件注册
├── skills/                   # 随包技能（会打进分发包）
│   ├── append-leaf/
│   │   ├── SKILL.md          # 记叶子技能
│   │   └── references/       # 格式示例
│   │       ├── knowledge-tree-example.md
│   │       └── index-example.md
│   └── organize-tree/
│       └── SKILL.md          # 整理知识树技能
├── dist/                     # 构建产物，包的实际入口（tsc 输出，不进 git）
├── cordis.patch.yml          # bundle 配置层，被 dsh.bundle.patch 引用
├── package.json              # 声明 dsh.bundle
├── tsconfig.json
├── CHANGELOG.md              # 变更记录 / release note
└── README.md
```

## 四个工具

| 工具 | 功能 |
|------|------|
| `append_leaf` | 追加知识叶子到"待整理"区，文件不存在自动创建 |
| `organize_tree` | 整理知识树（插入节点 / 移动节点） |
| `cleanup_organized_leaf` | 从待整理区删除已整理的叶子 |
| `update_index` | 更新索引文件 |

## 两个技能

| 技能 | 触发场景 |
|------|---------|
| `append-leaf` | 用户说"记一下""保存到知识树" |
| `organize-tree` | 用户说"整理知识树""归档待整理" |

## 安装

### 应用内安装（推荐）

在 DeepSeek Harness 前端界面进行下面的操作：

1. 在左侧侧栏点击【插件】进入插件页面；
2. 点击【+ 添加插件】按钮；
3. 在弹出的对话框里填入包名 `dsh-knowledge-tree`；
4. 点击【安装】。

装好后按【立即启用】，面板会提示「更改将在下次启动生效」，重启 DSH 后四个工具与两个技能即全部就位。

### 命令行安装

命令行方式适合开发调试，或者需要装本地目录、tarball、Git 源码的场景。

> **嫌命令行繁琐的话：直接把源码目录、tarball 或下面的 GitHub 链接发给DeepSeek Harness 智能体，让它帮你装。**
>
> 目前 DSH 的插件安装流程仍然比较繁琐——profile、bundle、`allowBuilds`、`--dump-config` 这些概念都要先弄明白，报错也未必直白。交给智能体比对着文档手动折腾快得多。
>

这是一个 DSH **bundle**：包内自带配置层 `cordis.patch.yml`，装进 profile 后会插入两行——四个工具，以及一行只贡献本包 `skills/` 的技能提供方。装完不需要手改任何配置。

#### npm 安装（推荐）

```bash
pnpm dsh plugin --profile <profile> add dsh-knowledge-tree
```

npm 上的包已经包含构建好的 `dist/`，安装时不会执行任何构建脚本，所以**不需要** `allowBuilds` 授权，也不需要出网到 GitHub。装完直接按下面的「验证」启动一次即可。

#### 本地目录安装（开发时最常用）

```bash
pnpm --dir dsh-knowledge-tree install
pnpm --dir dsh-knowledge-tree build

# 路径会被 pnpm 链接安装，改完代码重新 build 即生效
pnpm dsh plugin --profile <profile> add ./dsh-knowledge-tree
```

#### tarball 安装（不触发任何构建脚本）

```bash
pnpm --dir dsh-knowledge-tree pack
pnpm dsh plugin --profile <profile> add ./dsh-knowledge-tree-1.0.1.tgz
```

#### GitHub 安装

```bash
pnpm dsh plugin --profile <profile> add github:YunpengDon/dsh-knowledge-tree
```

git 安装拉的是源码，pnpm 会在安装时执行包里的 `prepare`（即 `tsc`）来构建 `dist/`。pnpm ≥10 默认拒绝执行依赖的构建脚本，第一次会失败并在报错里给出包名；把它加进该 profile 的 `pnpm-workspace.yaml` 后重试：
> （这个文件人工找需要对DSH比较熟悉才行，也不好找，最优解还是扔给你的DSH智能体）

```yaml
allowBuilds:
  dsh-knowledge-tree: true
```

这等于允许该包在你的机器上以你的权限执行代码，只对信任的源码这么做，并尽量固定 commit（`github:YunpengDon/dsh-knowledge-tree#<sha>`）。

另外注意：直连 GitHub 可能超时（国内网络尤其如此）。遇到时优先改用上面的本地目录或 tarball 方式，它们不需要任何出网安装。

## 验证

```bash
pnpm dsh --profile <profile> --dump-config | grep -n knowledge-tree
```

出现 `knowledge-tree` 与 `knowledge-tree-skills` 两行，说明配置层被应用了。但 `--dump-config` **不会求值 `!!js` 表达式**，所以它证明不了 `bundledSkillDir` 的路径解析成功——真正的验收是启动一次，让 `skill` 工具列出 `append-leaf` / `organize-tree`。

## 卸载

```bash
pnpm dsh plugin --profile <profile> remove dsh-knowledge-tree
```

## 与 DeepAgents 版本的主要差异

| 维度 | DeepAgents | DSH |
|------|-----------|-----|
| 语言 | Python | TypeScript |
| 工具注册 | `@tool` 装饰器 | `ctx.tools.register()` |
| 技能格式 | SKILL.md（含 `tools` 字段） | SKILL.md（`name` + `description` + `whenToUse`） |
| 文件权限 | `FilesystemPermission` 虚拟文件系统 | 自行实现路径安全检查 |
| HITL | `interrupt_on` 配置 | DSH 内置 HITL 机制 |
| 搜索 | DDGS（需翻墙） | 需自行接入国内数据源 |

# dsh-knowledge-tree

一个「把散落知识捋成自己的教程」的个人知识管理系统。在与 AI 的对话中收集零散知识（树叶），AI 自动归类到知识树，长期积累最终形成个人独有的知识体系。

## 文件结构

```
dsh-knowledge-tree/           # 包名 dsh-knowledge-tree
├── src/
│   ├── index.ts              # 工具实现 + 插件注册 + 配置
│   ├── hitl.ts               # 四张决策卡的字段与预览（挂到 dsh-hitl）
│   ├── markdown.ts           # Markdown 结构操作（纯函数：工具与预览共用同一组）
│   └── paths.ts              # 知识树文件的定位规则（工具与预览共用）
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

四个工具落盘前都会先要人点一次头，见下面的「人在环内」。

## 两个技能

| 技能 | 触发场景 |
|------|---------|
| `append-leaf` | 用户说"记一下""保存到知识树" |
| `organize-tree` | 用户说"整理知识树""归档待整理" |

## 人在环内（HITL）

四个工具都会改工作区里的文件，所以**每个工具落盘前都挂一张决策卡**。卡片由 [`dsh-hitl`](https://github.com/YunpengDon/dsh-hitl) **≥ 0.2.0** 提供——它是**可选**依赖：组合里没有它时，四个工具照常工作，只是少了人工确认这一环。

> ⚠️ **别配更旧的 dsh-hitl**：0.2.0 才引入「计算字段」，卡上的 diff 与「将被删除的内容」要靠它把磁盘上的原文交给卡片；用旧版时这两类字段拿不到值（正文、标题这些参数字段不受影响）。升级 dsh-hitl 即可，本插件这边不用改配置。

| 工具 | 卡上给人看什么 |
|------|---------------|
| `append_leaf` | 树叶正文**按 Markdown 渲染**（可编辑）。改好点【修改】：这次调用不会执行，模型拿你改的正文重新提交 |
| `organize_tree` | 插入 / 搬移的正文，外加**整理之后的整份文件 diff**——落点是这一步最容易出错的地方，直接看结果比看 `anchor` 直观 |
| `update_index` | **旧索引 vs 新索引的并排 diff**，外加可编辑的新正文 |
| `cleanup_organized_leaf` | 将被删掉的那片叶子的**原文**（只读）。删除不可撤销，这张卡只负责让你看清将要失去什么；不满意就拒绝，把原因写进反馈栏 |

卡上的预览**不是另算一份**：整理后的全文、将被删除的原文，都由工具实现用的同一组纯函数（`src/markdown.ts`）算出来，所以"卡上显示什么"与"将要写入什么"不会跑偏。算不出来时（锚点不存在、叶子不在待整理区、文件被删了）卡上直接写一句原因，而不是弹不出卡、或者装作没事。

配置（写在 profile 的 `cordis.patch.yml`）：

```yaml
- id: knowledge-tree
  name: 'dsh-knowledge-tree'
  config:
    hitl:
      enabled: true            # false = 完全不挂卡，四个工具直接落盘
      whenUnavailable: reject  # 没有任何浏览器连着时：reject（默认，fail-closed）/ wait
      countdownSeconds: null   # null = 不限时；给正整数则到点按"拒绝"处理
      rejectFeedback: true     # 拒绝时显示反馈栏
```

- **只有"可以改的东西"才给输入框**：正文、名称、锚点、落点、被搬移的标题都是输入框——改了就是"这次调用要改成这样"，点【修改】后这次调用**不会执行**，模型拿你的改动重新提交一次。反过来，**删除卡整张只读**（只能【同意】/【拒绝】，拒绝时可写原因），**删除卡与搬移卡的「知识树文件」也只读**：删哪片叶子、动哪个文件都是这次调用的既定对象，要换就拒绝并说明。diff 与"将被删除的内容"同样永远只读：它们是按**当前**参数算出来的结果，参数改了就等新卡重算。字段顺序照这条排：先参数，预览放最后。
- 1.1.0 之前的 `humanTurn` / `confirm` / `confirmTools` / `feedbackTools` / `confirmTimeoutSeconds` 已废弃：仍然认得出来，但只会各报一句警告（其中 `off` 会映射成 `hitl.enabled: false`）。
- 挂载点是 `tools/pre-execute`，也就是**先问人**：人同意之后，沙箱、审批等策略照常生效——用户同意不等于越权，别的执行前策略仍可能拒绝这次调用。
- 同进程子代理的工具调用同样会被拦下来，卡落在发起它的会话里；跨进程子代理不受管辖（那是 dsh-hitl 自己的边界）。
- 已知限制：预览读的是**弹卡那一刻**的文件。你看卡的时候若别的会话改了同一个文件，diff 与真正落盘的内容可能不一致——HITL 拦的是"调用开始之前"，它不是事务。

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
| HITL | `interrupt_on` 配置 | 挂到 [`dsh-hitl`](https://github.com/YunpengDon/dsh-hitl) 的决策卡上（四个工具各一张，见上文） |
| 搜索 | DDGS（需翻墙） | 需自行接入国内数据源 |

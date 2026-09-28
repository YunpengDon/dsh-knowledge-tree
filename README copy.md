# 知识树 DSH 插件

> 从 [DeepAgents 版本](https://github.com/YunpengDon/knowledge-tree-deepagents) 迁移到 DeepSeek Harness

## 文件结构

```
dsh-knowledge-tree/
├── src/
│   └── index.ts              # 全部代码：工具实现 + 插件注册
├── skills/
│   ├── append-leaf/
│   │   ├── SKILL.md          # 记叶子技能
│   │   └── references/       # 格式示例
│   │       ├── knowledge-tree-example.md
│   │       └── index-example.md
│   └── organize-tree/
│       └── SKILL.md          # 整理知识树技能
├── package.json
├── tsconfig.json
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

### 1. 编译

```bash
cd dsh-knowledge-tree
npm install
npm run build
```

### 2. 注册插件

在 DSH 配置文件（`~/.dsh/cordis.patch.yml` 或项目 `.dsh/cordis.patch.yml`）中添加：

```yaml
- name: './dsh-knowledge-tree'   # 插件路径
```

### 3. 注册技能

技能文件有两种注册方式：

**方式 A：bundledSkillDir（推荐）**

在 DSH 配置中添加 `skill-filesystem` 的 `bundledSkillDir` 配置：

```yaml
- name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    bundledSkillDir: ./dsh-knowledge-tree/skills
```

这样技能会随插件一起加载和卸载。

**方式 B：手动放置**

将 `skills/` 目录下的文件夹复制到 `~/.dsh/skills/`。

## 与 DeepAgents 版本的主要差异

| 维度 | DeepAgents | DSH |
|------|-----------|-----|
| 语言 | Python | TypeScript |
| 工具注册 | `@tool` 装饰器 | `ctx.tools.register()` |
| 技能格式 | SKILL.md（含 `tools` 字段） | SKILL.md（`name` + `description` + `whenToUse`） |
| 文件权限 | `FilesystemPermission` 虚拟文件系统 | 自行实现路径安全检查 |
| HITL | `interrupt_on` 配置 | DSH 内置 HITL 机制 |
| 搜索 | DDGS（需翻墙） | 需自行接入国内数据源 |

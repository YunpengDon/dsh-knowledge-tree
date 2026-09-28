/**
 * 知识树 DSH 插件
 *
 * 原项目：https://github.com/YunpengDon/knowledge-tree-deepagents
 * 迁移自 DeepAgents (Python) → DeepSeek Harness (TypeScript)
 *
 * 四个工具：
 *   1. append_leaf           — 追加知识叶子到"待整理"区
 *   2. organize_tree          — 整理知识树（插入/移动节点）
 *   3. cleanup_organized_leaf — 清理已整理的待整理叶子
 *   4. update_index           — 更新知识树索引文件
 */

import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { isAbsolute, join } from "node:path";

// ──────────────────────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────────────────────

/** 知识树文件夹名（相对于会话工作区）。 */
const KNOWLEDGE_TREES_DIRNAME = "knowledge-trees";

/** 无法定位会话工作区时的回退基准：进程启动目录。 */
const FALLBACK_BASE_DIR = process.cwd();

/**
 * 知识树的根目录：调用方会话的工作区 + `knowledge-trees`。
 *
 * 每个会话各用自己的工作区，因此不同项目/会话的知识树互相隔离；
 * 定位不到会话时回退到进程启动目录。
 */
function knowledgeTreesDir(exec?: ToolRunContext): string {
  const workspaceCwd = exec?.agent?.session.header.cwd;
  const base =
    workspaceCwd !== undefined && isAbsolute(workspaceCwd)
      ? workspaceCwd
      : FALLBACK_BASE_DIR;
  return join(base, KNOWLEDGE_TREES_DIRNAME);
}

/**
 * 解析知识树文件的绝对路径。
 *
 * 必须传绝对路径：本地后端解析相对路径时会用 `resolve(cwd, path)` 重新锚定到
 * `process.cwd()`，相对路径会被解析到源码目录而不是会话工作区。
 */
function resolveTreeFile(
  exec: ToolRunContext | undefined,
  relPath: string,
): string {
  const base = knowledgeTreesDir(exec);
  return isAbsolute(relPath) ? relPath : join(base, relPath);
}

/**
 * 写入知识树文件。所有写入都必须走这里。
 *
 * 直接调 `ctx.fs.writeText(target, content)` 会丢掉 per-call 沙箱策略，而
 * `SandboxedFileSystem` 缺省时会退回不带 session 的
 * `ctx.sandboxPolicy.resolve()`：那个 workspaceRoot 是部署级回退根
 * （`process.cwd()`），不是会话工作区。知识树文件在会话工作区内，containment
 * 判定因此失败，写入会被拒为 `FS_SANDBOX_DENIED`。补上带 session 的策略后，
 * workspaceRoot 与知识树的真实位置一致。
 */
async function writeTreeFile(
  ctx: Context,
  exec: ToolRunContext,
  target: FsTarget,
  content: string,
): Promise<void> {
  const sandboxPolicy = sandboxPolicyFor(ctx, exec);
  await ctx.fs.writeText(target, content, undefined, undefined, sandboxPolicy);
}

/** 本次调用的沙箱策略：带 session 解析，workspaceRoot 才会落在会话工作区。 */
function sandboxPolicyFor(
  ctx: Context,
  exec: ToolRunContext,
): SandboxExecutionPolicy | undefined {
  if (ctx.fs.sandboxMode === undefined) return undefined; // 不围栏：用后端默认
  // 不带 inject 的可选服务查找：宿主可能未挂载 sandboxPolicy。
  const sandboxPolicy: SandboxPolicyService | undefined =
    ctx.get("sandboxPolicy");
  if (sandboxPolicy === undefined) {
    throw new Error(
      "knowledge-tree: the mounted filesystem confines but ctx.sandboxPolicy is missing",
    );
  }
  return sandboxPolicy.resolve({ session: exec.agent?.session });
}

/** 新建知识树的初始内容：标题 + 待整理区 + 首条叶子。 */
function treeFile(treeName: string, content: string): string {
  // 标题后一个空行、待整理标题与首条叶子之间一个空行，与 insertNode 的接缝
  // 间距保持一致（原先是标题后两个空行、待整理标题与首叶之间零空行）。
  return `# ${treeName}\n\n## 🍂 待整理\n\n${content.replace(/\n+$/, "")}\n`;
}

// ──────────────────────────────────────────────────────────────
// 辅助函数（不暴露给模型）
// ──────────────────────────────────────────────────────────────

/**
 * 获取 Markdown 标题层级（# 的数量）
 */
function headingLevel(heading: string): number {
  return heading.match(/^#+/)?.[0].length ?? 0; // 计算一个 Markdown 标题字符串开头的 # 数量，也就是标题级别。正则的`^`表示字符串开头， `#+` 表示一个或多个连续的 #。；如果没有以 # 开头，就返回 0
}

/**
 * 在 md_text 中找到指定标题所在行号，找不到返回 -1
 */
function findHeadingLine(lines: string[], heading: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading.trim()) return i;
  }
  return -1;
}

/**
 * 从 startIdx+1 开始，找到下一个同级或更高级标题的行号
 * （即当前节点内容的边界），找不到返回 lines.length
 */
function findNodeBoundary(
  lines: string[],
  startIdx: number, // 开始查询的行号
  level: number,
): number {
  const pattern = new RegExp(`^#{1,${level}}\\s`); // 匹配比level级别高或相等的标题行。正则的`^`表示字符串开头，#{n,m} 表示匹配 n 到 m 个连续的 #， \s 表示匹配一个空白字符
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (pattern.test(lines[j].trim())) return j;
  }
  return lines.length;
}

/**
 * 插入节点：把 insert_content 插到 target_heading 节点内容的最开头或最末尾
 *
 * insert_at="start": 插在标题行下一行
 * insert_at="end":   插在节点内容末尾（下一个同级/更高级标题之前）
 *
 * 间距按"接缝"处理：先吸收插入点两侧已有的空行，再统一补恰好一个空行。
 * 若改成"在内容前无条件补一个空行"，接缝前已有空行时会产出双空行，
 * 接缝后紧跟标题时又会与下一个标题粘连。
 */
function insertNode(
  mdText: string,
  targetHeading: string,
  insertContent: string,
  insertAt: "start" | "end",
): string {
  const lines = mdText.split("\n");

  const idx = findHeadingLine(lines, targetHeading);
  if (idx === -1) throw new Error(`未找到节点: ${targetHeading}`);

  let insertPos: number;
  if (insertAt === "start") {
    insertPos = idx + 1;
  } else {
    const level = headingLevel(targetHeading);
    insertPos = findNodeBoundary(lines, idx, level);
  }

  // 吸收插入点两侧既有的空行，保证接缝恰好一个空行
  let before = insertPos;
  while (before > 0 && lines[before - 1].trim() === "") before--;
  let after = insertPos;
  while (after < lines.length && lines[after].trim() === "") after++;

  // 去掉内容尾部的所有换行，避免残留多余空行
  const block = insertContent.replace(/\n+$/, "").split("\n");

  return [
    ...lines.slice(0, before),
    "",
    ...block,
    "",
    ...lines.slice(after),
  ].join("\n");
}

/**
 * 规整 lines 中 pos 处的"接缝"：吸收两侧已有的空行，使接缝恰好留下一个空行。
 *
 * moveNode 搬走一个节点后，原地会留下一个接缝。若不规整，源文件该处原本
 * "缺空行"或"多空行"的问题会被原样保留。
 * 接缝之前没有任何实际内容时（pos 落在文首），不留空行。
 */
function normalizeSeam(lines: string[], pos: number): void {
  let before = pos;
  while (before > 0 && lines[before - 1].trim() === "") before--;
  let after = pos;
  while (after < lines.length && lines[after].trim() === "") after++;

  const filler = before === 0 ? [] : [""];
  lines.splice(before, after - before, ...filler);
}

/**
 * 移动节点：把 source_heading 节点（含标题和正文）移动到 target_heading 节点的开头或末尾
 *
 * 传入 new_heading 时，会在搬移的同时改写源节点的标题——用于把"待整理"里的
 * 树叶提升到正文时去掉标题中的日期，从而无需重新提交整片树叶的正文。
 */
function moveNode(
  mdText: string,
  sourceHeading: string,
  targetHeading: string,
  insertAt: "start" | "end",
  newHeading?: string,
): string {
  const lines = mdText.split("\n");

  const sourceIdx = findHeadingLine(lines, sourceHeading);
  if (sourceIdx === -1) throw new Error(`未找到源节点: ${sourceHeading}`);

  const targetIdx = findHeadingLine(lines, targetHeading);
  if (targetIdx === -1) throw new Error(`未找到目标节点: ${targetHeading}`);

  // 提取源节点内容（标题 + 正文，到下一个同级/更高级标题之前）
  const level = headingLevel(sourceHeading);
  const endIdx = findNodeBoundary(lines, sourceIdx, level);

  // 目标节点若是源节点自身或其后代，搬移没有意义／会连带删掉目标，提前拦截
  if (targetIdx === sourceIdx || (targetIdx > sourceIdx && targetIdx < endIdx)) {
    throw new Error(`目标节点不能是源节点自身或其子节点: ${targetHeading}`);
  }

  const sourceLines = lines.slice(sourceIdx, endIdx);
  if (newHeading !== undefined) {
    const trimmed = newHeading.trim();
    if (/\n/.test(trimmed) || !/^#{1,6}\s+\S/.test(trimmed)) {
      throw new Error(`new_heading 必须是单行标题，例如 "### 标题"`);
    }
    sourceLines[0] = trimmed;
  }
  const sourceContent = sourceLines.join("\n");

  // 先删除源节点，并规整搬走处留下的接缝
  lines.splice(sourceIdx, endIdx - sourceIdx);
  normalizeSeam(lines, sourceIdx);
  const afterDelete = lines.join("\n");

  // 再用 insertNode 插入到目标位置
  return insertNode(afterDelete, targetHeading, sourceContent, insertAt);
}

/**
 * 统计"## 🍂 待整理"区域下的叶子节点数量
 * 叶子节点格式：### [日期] 标题
 */
function getPendingLeafCount(mdText: string): number {
  const lines = mdText.split("\n");
  const pendingIdx = findHeadingLine(lines, "## 🍂 待整理");
  if (pendingIdx === -1) throw new Error("未找到待整理区域");

  let count = 0;
  for (let j = pendingIdx + 1; j < lines.length; j++) {
    if (/^### \[\d/.test(lines[j].trim())) count++;
  }
  return count;
}

// ──────────────────────────────────────────────────────────────
// 插件注册
// ──────────────────────────────────────────────────────────────

/** 插件名称 */
export const name = "knowledge-tree";

/** 声明依赖的 Cordis 服务 */
export const inject = ["tools", "fs"];

/**
 * 创建一个简单的文本输出定义
 * 所有工具的返回值都是 string，统一用这个
 */
function textOutput() {
  return {
    schema: { type: "string" as const },
    render(_args: unknown, value: unknown) {
      return [{ type: "text" as const, text: String(value) }];
    },
  };
}

/**
 * 插件入口函数
 */
export function apply(ctx: Context): void {
  // ── 工具 1：append_leaf ──
  ctx.tools.register({
    name: "append_leaf",
    description:
      "Append content to a knowledge tree file. If the file does not exist, it will be created with a basic structure.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the knowledge tree file (e.g. 'python.md')",
        },
        tree_name: {
          type: "string",
          description:
            "The name of the knowledge tree (used when creating a new file)",
        },
        content: {
          type: "string",
          description:
            "Content to append, formatted as a third-level heading with date, title, and body",
        },
      },
      required: ["path", "tree_name", "content"],
    },
    output: textOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const {
        path: relPath,
        tree_name: treeName,
        content,
      } = args as {
        path: string;
        tree_name: string;
        content: string;
      };

      // 路径解析到调用方会话工作区下的 knowledge-trees 目录
      const target = await ctx.fs.resolve(resolveTreeFile(exec, relPath));
      const info = await ctx.fs.stat(target); // 检查文件是否存在，返回 FsInfo 或 null

      if (!info) {
        // 文件不存在，创建（含基础结构 + 首条内容）
        await writeTreeFile(ctx, exec, target, treeFile(treeName, content));
      } else {
        // 文件存在，追加（ctx.fs 没有 append，用 read + concat + write）
        // 规整接缝：已有内容尾部收敛为恰好一个空行，新内容去掉尾部换行。
        // 不能依赖调用方传入的尾换行来凑分隔，否则相邻两片叶子会粘连。
        const existing = await ctx.fs.readText(target);
        const head = `${existing.replace(/\n+$/, "")}\n\n`;
        const body = content.replace(/\n+$/, "");
        await writeTreeFile(ctx, exec, target, `${head}${body}\n`);
      }

      return `已将内容追加到 ${relPath}`;
    },
  });

  // ── 工具 2：organize_tree ──
  ctx.tools.register({
    name: "organize_tree",
    description:
      "Insert a new node or move an existing node within a knowledge tree file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Name of the knowledge tree file (e.g. 'python.md')",
        },
        op: {
          type: "string",
          enum: ["insert_node", "move_node"],
          description: "Operation type: insert_node or move_node",
        },
        anchor: {
          type: "string",
          description:
            "Target heading to insert/move at (must already exist in the document)",
        },
        insert_at: {
          type: "string",
          enum: ["start", "end"],
          description:
            "Position: start (beginning of anchor node) or end (end of anchor node)",
        },
        content: {
          type: "string",
          description:
            'New node text (required for insert_node). Example: "## New Section\\nBody text"',
        },
        source_heading: {
          type: "string",
          description: "Heading of the node to move (required for move_node)",
        },
        new_heading: {
          type: "string",
          description:
            'Optional single-line heading to rewrite the moved node\'s title with (move_node only). Use it to drop the [date] when promoting a pending leaf into the body. Example: "### Some Topic"',
        },
      },
      required: ["path", "op", "anchor", "insert_at"],
    },
    output: textOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const {
        path: relPath,
        op,
        anchor,
        insert_at: insertAt,
        content,
        source_heading: sourceHeading,
        new_heading: newHeading,
      } = args as {
        path: string;
        op: "insert_node" | "move_node";
        anchor: string;
        insert_at: "start" | "end";
        content?: string;
        source_heading?: string;
        new_heading?: string;
      };

      const target = await ctx.fs.resolve(resolveTreeFile(exec, relPath));
      const info = await ctx.fs.stat(target);
      if (!info) return `文件未找到: ${relPath}`;

      const mdText = await ctx.fs.readText(target);

      let newMdText: string;
      try {
        if (op === "insert_node") {
          if (!content) return "insert_node 模式需要 content 参数";
          newMdText = insertNode(mdText, anchor, content, insertAt);
        } else if (op === "move_node") {
          if (!sourceHeading) return "move_node 模式需要 source_heading 参数";
          newMdText = moveNode(
            mdText,
            sourceHeading,
            anchor,
            insertAt,
            newHeading,
          );
        } else {
          return `不支持的操作: ${op}`;
        }
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }

      await writeTreeFile(ctx, exec, target, newMdText);
      return `知识树已更新: ${relPath}`;
    },
  });

  // ── 工具 3：cleanup_organized_leaf ──
  ctx.tools.register({
    name: "cleanup_organized_leaf",
    description:
      "Remove an organized leaf from the pending section of a knowledge tree file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Name of the knowledge tree file (e.g. 'python.md')",
        },
        leaf_heading: {
          type: "string",
          description:
            'Heading of the leaf to remove (e.g. "### [2026/8/27] Some Topic")',
        },
      },
      required: ["path", "leaf_heading"],
    },
    output: textOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const { path: relPath, leaf_heading: leafHeading } = args as {
        path: string;
        leaf_heading: string;
      };

      const target = await ctx.fs.resolve(resolveTreeFile(exec, relPath));
      const info = await ctx.fs.stat(target);
      if (!info) return `文件未找到: ${relPath}`;

      const mdText = await ctx.fs.readText(target);
      const lines = mdText.split("\n");

      const pendingIdx = findHeadingLine(lines, "## 🍂 待整理");
      if (pendingIdx === -1) return `未找到待整理区域: ${relPath}`;

      let leafIdx = -1;
      for (let j = pendingIdx + 1; j < lines.length; j++) {
        if (lines[j].trim() === leafHeading) {
          leafIdx = j;
          break;
        }
      }
      if (leafIdx === -1) return `未找到叶子节点: ${leafHeading}`;

      const level = headingLevel(leafHeading);
      const endIdx = findNodeBoundary(lines, leafIdx, level);
      lines.splice(leafIdx, endIdx - leafIdx);

      const newMdText = lines.join("\n");

      // v2 改动：ctx.fs
      await writeTreeFile(ctx, exec, target, newMdText);

      const remaining = getPendingLeafCount(newMdText);
      return `知识树已更新: ${relPath}, 待整理区剩余 ${remaining} 个叶子节点。`;
    },
  });

  // ── 工具 4：update_index ──
  ctx.tools.register({
    name: "update_index",
    description:
      "Update the knowledge tree index file. Overwrites the entire file content.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            'Full content of the index file. Example: "- [Python](./programming.md) — Python, Deep Agents"',
        },
      },
      required: ["content"],
    },
    output: textOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const { content } = args as { content: string };

      const target = await ctx.fs.resolve(resolveTreeFile(exec, "index.md"));
      const info = await ctx.fs.stat(target);

      let finalContent = content;
      if (!info) {
        finalContent = "# 知识树索引\n\n" + content;
      }

      await writeTreeFile(ctx, exec, target, finalContent);
      return "索引文件已更新";
    },
  });
}

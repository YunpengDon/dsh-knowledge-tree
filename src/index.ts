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
import {
  PENDING_HEADING,
  findHeadingLine,
  getPendingLeafCount,
  insertNode,
  moveNode,
  removeNode,
} from "./markdown.js";

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
  return `# ${treeName}\n\n${PENDING_HEADING}\n\n${content.replace(/\n+$/, "")}\n`;
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

      let newMdText: string;
      try {
        const pendingIdx = findHeadingLine(lines, PENDING_HEADING);
        if (pendingIdx === -1) return `未找到待整理区域: ${relPath}`;
        // 只在"待整理"区之后查找：正文里的同名标题不会被误删
        if (findHeadingLine(lines, leafHeading, pendingIdx + 1) === -1) {
          return `未找到叶子节点: ${leafHeading}`;
        }
        newMdText = removeNode(mdText, leafHeading, pendingIdx + 1);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }

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

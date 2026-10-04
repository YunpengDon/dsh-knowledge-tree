/**
 * 知识树文件的定位规则：会话工作区 + `knowledge-trees`。
 *
 * 单独成一个文件的原因只有一个：工具实现（index.ts）与 HITL 预览（hitl.ts）
 * 都要用它，而 index.ts 又要 import hitl.ts——让 hitl.ts 反过来 import
 * index.ts 会成环。
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { isAbsolute, join } from "node:path";

/** 知识树文件夹名（相对于会话工作区）。 */
export const KNOWLEDGE_TREES_DIRNAME = "knowledge-trees";

/** 无法定位会话工作区时的回退基准：进程启动目录。 */
const FALLBACK_BASE_DIR = process.cwd();

/**
 * 知识树的根目录：调用方会话的工作区 + `knowledge-trees`。
 *
 * 每个会话各用自己的工作区，因此不同项目/会话的知识树互相隔离；
 * 定位不到会话时回退到进程启动目录。
 */
export function knowledgeTreesDir(exec?: ToolExecution): string {
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
export function resolveTreeFile(
  exec: ToolExecution | undefined,
  relPath: string,
): string {
  const base = knowledgeTreesDir(exec);
  return isAbsolute(relPath) ? relPath : join(base, relPath);
}

/** 确认卡上显示的路径：模型给的相对路径补上目录名，绝对路径原样。 */
export function treeLabel(relPath: string): string {
  return isAbsolute(relPath) ? relPath : join(KNOWLEDGE_TREES_DIRNAME, relPath);
}

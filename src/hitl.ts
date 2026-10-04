/**
 * 知识树的"人在环内"（HITL）：把四个工具挂到 dsh-hitl 的决策卡上。
 *
 * 为什么挂在 dsh-hitl 上、而不是自带一套卡片：卡片本身（Markdown 预览与编辑、
 * 并排 diff、拒绝反馈、失败关闭、倒计时）是通用能力，知识树只需要回答"这张卡
 * 该给人看什么"。所以这里只有两件事：
 *
 *   1. 声明每张卡的字段、标题与顺序；
 *   2. 弹卡前把**参数之外的文本**算出来——磁盘上的旧索引、将被删除的叶子原文、
 *      整理之后的整份文件（dsh-hitl ≥ 0.2.0 的"计算字段"）。这些计算与工具的
 *      execute 走同一组纯函数（markdown.ts），所以卡上显示的就是将要落盘的东西。
 *
 * 预算是"失败也要能决策"：算不出来时，卡上写一句人话（`⚠️ …`），而不是抛给
 * 门禁、或者干脆不弹卡。HITL 只决定"这次调用要不要执行"，它不改参数、不改结果。
 *
 * ## 四张卡共用的两条规矩
 *
 *   1. **输入框只给"可以改的东西"**——正文、名称、锚点、落点、被搬移的标题都是
 *      输入框：人改了就是"这次调用要改成这样"，提交后这次调用**不会执行**，模型
 *      拿改动重新发起一次（HITL 的 revise-request 语义）。反过来，**删除卡整张只读**，
 *      **删除卡与搬移卡的"知识树文件"也只读**：删哪片叶子、动哪个文件都是这次调用
 *      的既定对象，要换就【拒绝】并说明。字段顺序也因此是"先参数、后预览"。
 *   2. **预览只读**——diff、将被删除的原文都是**按当前参数算出来的结果**，
 *      不给人编辑：参数一旦被改，以重新提交后的新卡为准。
 *
 * 依赖是可选的：组合里没有 dsh-hitl 时四个工具照常工作，只是没有确认卡。
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import {
  PENDING_HEADING,
  findHeadingLine,
  getPendingLeafCount,
  indexFileText,
  insertNode,
  moveNode,
  nodeText,
  removeNode,
} from "./markdown.js";
import { treeLabel } from "./paths.js";

// ──────────────────────────────────────────────────────────────
// dsh-hitl 的服务形状（只声明本插件用到的成员）
// ──────────────────────────────────────────────────────────────

/** 字段值：字面量，或这次调用的计算函数（宿主弹卡前调用它）。 */
export type HitlValue =
  | string
  | ((exec: ToolExecution) => string | Promise<string>);

/** dsh-hitl 的 FieldSpec。 */
export interface HitlFieldSpec {
  param: string;
  title?: string;
  description?: string;
  render?: "markdown" | "text" | "diff" | "json" | "hidden";
  editable?: boolean;
  labels?: string[];
  value?: HitlValue;
  diff?: {
    before: HitlValue;
    after: HitlValue;
    path?: HitlValue;
    title?: string;
  };
}

/** dsh-hitl 的挂载选项。 */
export interface HitlMountOptions {
  title?: string;
  layout?: "stacked" | "split";
  labels?: string[];
  fields?: HitlFieldSpec[];
  diff?: HitlFieldSpec["diff"];
  countdown?:
    | { seconds: number; action: "approve" | "reject" | "notify"; freezeOnInteract?: boolean }
    | null;
  reject?: { feedback?: boolean; feedbackPrompt?: string; requireFeedback?: boolean };
  modify?: { mode?: "revise-request" | "allow-and-inform" };
  whenUnavailable?: "reject" | "wait";
  enabled?: boolean | ((exec: ToolExecution) => boolean);
  maxFieldChars?: number;
  resolveTimeoutMs?: number;
}

/** dsh-hitl 提供的 `hitl` 服务。 */
export interface HitlService {
  protect(matcher: unknown, options?: HitlMountOptions, owner?: unknown): () => void;
  unprotect(matcher: unknown): number;
  list(): unknown[];
  pending(): unknown[];
}

// ──────────────────────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────────────────────

/** 知识树侧可调的 HITL 行为（profile 里 `config.hitl`）。 */
export interface HitlConfig {
  /** 总开关：关掉就完全不挂载（四个工具直接落盘）。 */
  enabled: boolean;
  /** 没有任何浏览器连着时：fail-closed（默认）还是一直等。 */
  whenUnavailable: "reject" | "wait";
  /** 卡片的倒计时秒数；null = 不限时（可以被中断，但不会自己过期）。 */
  countdownSeconds: number | null;
  /** 拒绝时是否显示反馈栏。 */
  rejectFeedback: boolean;
}

/** 默认：拦、fail-closed、不限时、拒绝可带原因。 */
export const DEFAULT_HITL_CONFIG: HitlConfig = {
  enabled: true,
  whenUnavailable: "reject",
  countdownSeconds: null,
  rejectFeedback: true,
};

/** `config.hitl` 允许出现的键；其余只警告、不抛出。 */
const KNOWN_HITL_KEYS = new Set([
  "enabled",
  "whenUnavailable",
  "countdownSeconds",
  "rejectFeedback",
]);

/**
 * 校验并补全 `config.hitl`。
 *
 * 非法值一律"退回默认 + 报一句"，不在插件加载时抛异常：一个写错的超时秒数
 * 不该让四个工具整体不可用。
 *
 * @param raw - profile 里 `config.hitl` 的原始值。
 * @param warn - 诊断出口，调用方补上插件名前缀。
 */
export function normalizeHitlConfig(
  raw: unknown,
  warn: (message: string) => void,
): HitlConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_HITL_CONFIG };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("config.hitl 必须是一个映射，已改用默认值");
    return { ...DEFAULT_HITL_CONFIG };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_HITL_KEYS.has(key)) {
      warn(`config.hitl 里不认识的键 "${key}"（已忽略）`);
    }
  }
  const config = { ...DEFAULT_HITL_CONFIG };
  if (record.enabled !== undefined) {
    if (typeof record.enabled === "boolean") config.enabled = record.enabled;
    else warn("config.hitl.enabled 必须是布尔值（已忽略）");
  }
  if (record.whenUnavailable !== undefined) {
    if (record.whenUnavailable === "reject" || record.whenUnavailable === "wait") {
      config.whenUnavailable = record.whenUnavailable;
    } else {
      warn('config.hitl.whenUnavailable 只能是 "reject" 或 "wait"（已忽略）');
    }
  }
  if (record.rejectFeedback !== undefined) {
    if (typeof record.rejectFeedback === "boolean") {
      config.rejectFeedback = record.rejectFeedback;
    } else {
      warn("config.hitl.rejectFeedback 必须是布尔值（已忽略）");
    }
  }
  if (record.countdownSeconds !== undefined && record.countdownSeconds !== null) {
    const seconds = record.countdownSeconds;
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0) {
      config.countdownSeconds = seconds;
    } else {
      warn("config.hitl.countdownSeconds 必须是正整数秒或 null（已忽略）");
    }
  }
  return config;
}

// ──────────────────────────────────────────────────────────────
// 调用参数的读取
// ──────────────────────────────────────────────────────────────

/** 本插件认识的参数名。 */
type ArgKey =
  | "path"
  | "tree_name"
  | "content"
  | "op"
  | "anchor"
  | "insert_at"
  | "source_heading"
  | "new_heading"
  | "leaf_heading";

/** 取一个字符串参数；没给、或不是字符串，一律当作没给。 */
function argOf(exec: ToolExecution, key: ArgKey): string | undefined {
  const args: unknown = exec.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** 目标文件：模型写的相对路径（工具那边会补上 knowledge-trees 前缀）。 */
function pathOf(exec: ToolExecution): string {
  return argOf(exec, "path") ?? "";
}

// ──────────────────────────────────────────────────────────────
// 预览计算（纯函数 + 一个读文件的注入点）
// ──────────────────────────────────────────────────────────────

/** 预览计算的结果：要么是文本，要么是一句"这次会失败"的人话。 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 把抛出的值变成一句可读的原因。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取知识树文件（弹卡前的预览用）；文件不存在返回 null。 */
export type TreeReader = (
  exec: ToolExecution,
  relPath: string,
) => Promise<string | null>;

/** 挂载所需的依赖：读文件的函数 + 归一化后的配置。 */
export interface MountDeps {
  readTree: TreeReader;
  config: HitlConfig;
}

/**
 * 整理之后的文件全文。
 *
 * 与 organize_tree 的 execute 用同一组纯函数、同一套参数校验顺序，因此
 * "预览里算得出来"与"调用能成功"是同一件事；算不出来时卡上直接说原因。
 */
export function organizeResult(
  mdText: string,
  exec: ToolExecution,
): Outcome<string> {
  const anchor = argOf(exec, "anchor");
  const insertAt = argOf(exec, "insert_at") === "start" ? "start" : "end";
  if (anchor === undefined || anchor.trim() === "") {
    return { ok: false, reason: "缺少 anchor 参数" };
  }
  const op = argOf(exec, "op");
  try {
    if (op === "insert_node") {
      const content = argOf(exec, "content");
      if (content === undefined) {
        return { ok: false, reason: "insert_node 需要 content 参数" };
      }
      return { ok: true, value: insertNode(mdText, anchor, content, insertAt) };
    }
    if (op === "move_node") {
      const source = argOf(exec, "source_heading");
      if (source === undefined) {
        return { ok: false, reason: "move_node 需要 source_heading 参数" };
      }
      return {
        ok: true,
        value: moveNode(mdText, source, anchor, insertAt, argOf(exec, "new_heading")),
      };
    }
    return { ok: false, reason: `不支持的操作: ${String(op)}` };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/**
 * 删除树叶的预览：将被删掉的原文，以及删除后待整理区剩余的数量。
 *
 * 与 cleanup_organized_leaf 的 execute 同样只在"待整理"区之后查找：正文里的
 * 同名标题既不会被误删，也不会出现在这张卡上。
 *
 * 卡上只显示 `removed`：剩余数量被当成冗余信息去掉了（要数叶子的话，下一步
 * 工具的返回里本来就会报）。这里照旧返回它，是因为它属于"这次操作干了什么"
 * 的完整事实，留给调用方与测试用。
 */
export function removalResult(
  mdText: string,
  exec: ToolExecution,
): Outcome<{ removed: string; remaining: number }> {
  const heading = argOf(exec, "leaf_heading");
  if (heading === undefined || heading.trim() === "") {
    return { ok: false, reason: "缺少 leaf_heading 参数" };
  }
  try {
    const lines = mdText.split("\n");
    const pendingIdx = findHeadingLine(lines, PENDING_HEADING);
    if (pendingIdx === -1) return { ok: false, reason: "未找到待整理区域" };
    if (findHeadingLine(lines, heading, pendingIdx + 1) === -1) {
      return { ok: false, reason: `待整理区里没有这片叶子: ${heading}` };
    }
    const removed = nodeText(mdText, heading, pendingIdx + 1);
    if (removed === null) {
      return { ok: false, reason: `待整理区里没有这片叶子: ${heading}` };
    }
    return {
      ok: true,
      value: {
        removed,
        remaining: getPendingLeafCount(removeNode(mdText, heading, pendingIdx + 1)),
      },
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/** 一份"这次调用会把某个文件变成什么"的预览。 */
export interface FilePreview {
  /** 目标文件（模型给的相对路径）。 */
  path(exec: ToolExecution): string;
  /**
   * 由磁盘现状推出这次调用之后的全文。
   * @param mdText - 磁盘现状；文件不存在是 null（由实现决定这是不是错误）。
   */
  project(mdText: string | null, exec: ToolExecution): Outcome<string>;
}

/** organize_tree 的整文件预览：把这次插入/搬移在内存里先做一遍。 */
export function organizePreview(): FilePreview {
  return {
    path: pathOf,
    project: (mdText, exec) =>
      mdText === null
        ? { ok: false, reason: `文件未找到: ${pathOf(exec)}` }
        : organizeResult(mdText, exec),
  };
}

/** update_index 的整文件预览：文件不存在时会补上索引标题。 */
export function indexPreview(): FilePreview {
  return {
    path: () => "index.md",
    project: (mdText, exec) => indexResult(mdText, exec),
  };
}

/** 索引文件最终的全文：与 update_index 的 execute 同一条规则。 */
export function indexResult(
  existing: string | null,
  exec: ToolExecution,
): Outcome<string> {
  const content = argOf(exec, "content");
  if (content === undefined) return { ok: false, reason: "缺少 content 参数" };
  return { ok: true, value: indexFileText(existing, content) };
}

/**
 * 一张整文件 diff 的计算字段：before 是磁盘现状，after 是这次调用算出来的结果。
 *
 * 失败时**不摆出"整篇被删掉"的样子**：两侧都以原文开头，只在末尾追加一行
 * `⚠️ …`——人一眼看到的是"这次会失败"，而不是"文件要被清空"。
 */
function fileDiffField(
  deps: MountDeps,
  preview: FilePreview,
  title: string,
): HitlFieldSpec {
  return {
    param: "diff",
    title,
    render: "diff",
    editable: false,
    diff: {
      path: exec => treeLabel(preview.path(exec)),
      before: async exec => (await deps.readTree(exec, preview.path(exec))) ?? "",
      after: async exec => {
        const mdText = await deps.readTree(exec, preview.path(exec));
        const result = preview.project(mdText, exec);
        if (result.ok) return result.value;
        return mdText === null
          ? `⚠️ ${result.reason}`
          : `${mdText.replace(/\n+$/, "")}\n\n⚠️ 这次调用会失败：${result.reason}\n`;
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────
// 四张卡
// ──────────────────────────────────────────────────────────────

/**
 * append_leaf：正文按 Markdown 渲染。
 *
 * 正文可编辑——人改完点【修改】，这次调用不会执行，模型拿着改好的正文重新
 * 提交一次（HITL 的 `revise-request` 语义：它不改参数，也就不假装改过）。
 */
/**
 * append_leaf：文件 → 名称 → 正文，三个都能在卡上改。
 *
 * `tree_name` 只在新建文件时用作标题，但照样可编辑——人可能就是想把名字改掉。
 */
export function appendLeafMount(): HitlMountOptions {
  return {
    title: "追加知识树叶",
    fields: [
      { param: "path", title: "知识树文件", render: "text" },
      { param: "tree_name", title: "知识树名称（新建文件时用作标题）", render: "text" },
      {
        param: "content",
        title: "树叶正文",
        description:
          "按 Markdown 渲染。改好后点【修改】：这次调用不会执行，模型会拿你改的正文重新提交。",
        render: "markdown",
      },
    ],
  };
}

/** organize_tree 的兜底卡：`op` 缺失或非法时也拦得住（字段取全部参数）。 */
export function organizeFallbackMount(): HitlMountOptions {
  return { title: "整理知识树", labels: ["改动文件"] };
}

/**
 * organize_tree · insert_node：正文 + 整理之后的整份文件。
 *
 * 落点看 diff 比看 `anchor` 直观得多——"插入到哪个标题下"正是这一步最容易
 * 搞错的地方，所以卡上直接给出插入之后的全文对照。
 */
/**
 * organize_tree · insert_node：插入的正文 + 整理之后的整份文件。
 *
 * 落点看 diff 比看 `anchor` 直观得多——"插入到哪个标题下"正是这一步最容易
 * 搞错的地方，所以卡上直接给出插入之后的全文对照；锚点写错了也能在卡上改。
 */
export function organizeInsertMount(deps: MountDeps): HitlMountOptions {
  return {
    title: "整理知识树 · 插入节点",
    labels: ["改动文件"],
    fields: [
      { param: "path", title: "知识树文件", render: "text" },
      { param: "anchor", title: "锚点节点（已存在的标题）", render: "text" },
      { param: "insert_at", title: "插入位置（start / end）", render: "text" },
      { param: "content", title: "要插入的正文", render: "markdown" },
      fileDiffField(deps, organizePreview(), "整理后的文件（按上面的参数算出来）"),
    ],
  };
}

/**
 * organize_tree · move_node：搬移与被改写后的标题 + 整理之后的整份文件。
 *
 * 文件只读：搬移的对象是"哪个文件里的哪个节点"，换文件等于换一次操作，不该在
 * 这张卡上顺手改掉。节点与落点照旧可编辑。
 */
export function organizeMoveMount(deps: MountDeps): HitlMountOptions {
  return {
    title: "整理知识树 · 搬移节点",
    labels: ["改动文件"],
    fields: [
      { param: "path", title: "知识树文件", render: "text", editable: false },
      { param: "source_heading", title: "被搬移的节点", render: "text" },
      { param: "anchor", title: "目标节点（已存在的标题）", render: "text" },
      { param: "insert_at", title: "落点（start / end）", render: "text" },
      {
        param: "new_heading",
        title: "改写后的标题（可留空）",
        description: "搬移的同时改写源节点的标题，用来去掉待整理叶子标题里的日期；留空则原样搬。",
        render: "text",
      },
      fileDiffField(deps, organizePreview(), "整理后的文件（按上面的参数算出来）"),
    ],
  };
}

/** update_index：新索引正文 + 旧索引 vs 新索引的整文件 diff。 */
export function updateIndexMount(deps: MountDeps): HitlMountOptions {
  return {
    title: "更新知识树索引",
    labels: ["覆盖整个文件"],
    fields: [
      {
        param: "content",
        title: "新索引正文",
        description:
          "改好后点【修改】：这次调用不会执行，模型会拿你改的正文重新提交（下面的 diff 也会跟着重算）。",
        render: "markdown",
      },
      fileDiffField(deps, indexPreview(), "索引文件的变化（按上面的正文算出来）"),
    ],
  };
}

/**
 * cleanup_organized_leaf：整张卡只读。
 *
 * 这张卡不是编辑面板，而是一次确认：删哪片叶子、在哪个文件里、将要失去什么，
 * 都是这次调用的既定对象——人只能【同意】或【拒绝】（拒绝时可以写原因）。
 * 删除不可撤销，而工具无法自证"这片叶子确实已经进正文了"，所以预览只做一件事：
 * 让人看见将要失去什么。
 */
export function cleanupMount(deps: MountDeps): HitlMountOptions {
  return {
    title: "删除待整理区的树叶",
    labels: ["不可撤销"],
    reject: { feedbackPrompt: "例如：这片还没进正文，先别删" },
    fields: [
      { param: "path", title: "知识树文件", render: "text", editable: false },
      {
        param: "leaf_heading",
        title: "要删除的树叶",
        description: "只删待整理区里的这个标题；正文里的同名标题不受影响。",
        render: "text",
        editable: false,
      },
      {
        param: "removed",
        title: "将被删除的内容",
        description: "磁盘上的原文（按上面的标题查出来）。确认它已经进了正文，再放行删除。",
        render: "markdown",
        editable: false,
        value: async exec => {
          const mdText = await deps.readTree(exec, pathOf(exec));
          if (mdText === null) return `⚠️ 文件未找到: ${pathOf(exec)}`;
          const result = removalResult(mdText, exec);
          return result.ok ? result.value.removed : `⚠️ ${result.reason}`;
        },
      },
    ],
  };
}

// ──────────────────────────────────────────────────────────────
// 挂载
// ──────────────────────────────────────────────────────────────

/** 一张待挂载的卡：名字只用于日志与诊断。 */
export interface PlannedMount {
  name: string;
  matcher: unknown;
  options: HitlMountOptions;
}

/** 只有这一种 op 才走这张卡：另一种 op 的字段不会出现在卡上。 */
export function isInsertNode(exec: ToolExecution): boolean {
  return exec.name === "organize_tree" && argOf(exec, "op") === "insert_node";
}

/** @see isInsertNode */
export function isMoveNode(exec: ToolExecution): boolean {
  return exec.name === "organize_tree" && argOf(exec, "op") === "move_node";
}

/** 四张卡的共用行为：无人可问时怎么办、要不要倒计时、拒绝要不要带原因。 */
function baseOptions(config: HitlConfig): HitlMountOptions {
  return {
    whenUnavailable: config.whenUnavailable,
    countdown:
      config.countdownSeconds === null
        ? null
        : { seconds: config.countdownSeconds, action: "reject" },
    reject: { feedback: config.rejectFeedback },
  };
}

/**
 * 挂载清单。**顺序就是匹配优先级**：dsh-hitl 取"最后注册的匹配"，
 * 所以兜底卡先注册，两种具体形态后注册，用它俩覆盖兜底。
 */
export function hitlMounts(deps: MountDeps): PlannedMount[] {
  return [
    { name: "organize_tree", matcher: "organize_tree", options: organizeFallbackMount() },
    { name: "organize_tree(insert_node)", matcher: isInsertNode, options: organizeInsertMount(deps) },
    { name: "organize_tree(move_node)", matcher: isMoveNode, options: organizeMoveMount(deps) },
    { name: "append_leaf", matcher: "append_leaf", options: appendLeafMount() },
    { name: "update_index", matcher: "update_index", options: updateIndexMount(deps) },
    { name: "cleanup_organized_leaf", matcher: "cleanup_organized_leaf", options: cleanupMount(deps) },
  ];
}

/**
 * 把四个工具挂到 dsh-hitl 上。
 *
 * `owner` 传调用方的 Cordis 上下文：挂载记在 hitl 插件里，只有 effect 才能让
 * 它在"本插件卸载 / hitl 重载"时自动解绑（从 `apply` 里 return 一个 disposer
 * 不算生命周期）。
 *
 * @returns 已挂载的卡名；`enabled: false` 时是空数组。
 */
export function mountHitl(
  hitl: HitlService,
  deps: MountDeps,
  owner?: unknown,
): string[] {
  if (!deps.config.enabled) return [];
  const base = baseOptions(deps.config);
  const mounted: string[] = [];
  for (const planned of hitlMounts(deps)) {
    hitl.protect(
      planned.matcher,
      {
        ...base,
        ...planned.options,
        // 卡可以只覆盖反馈提示语，而不丢掉整份 reject 配置。
        reject: { ...base.reject, ...planned.options.reject },
      },
      owner,
    );
    mounted.push(planned.name);
  }
  return mounted;
}

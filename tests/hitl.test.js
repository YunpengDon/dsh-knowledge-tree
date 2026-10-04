/**
 * src/hitl.ts 的回归测试：四张决策卡长什么样、卡上的预览算得对不对。
 *
 * 这里不启 Cordis、也不连 dsh-hitl：用一份假的服务记录"挂了什么"，用一个假的
 * 读文件函数喂进磁盘内容。锁住两件事——
 *
 *   1. 挂载清单与顺序（dsh-hitl 取"最后注册的匹配"，所以顺序就是优先级）；
 *   2. 预览与工具 execute 走的是同一组纯函数：卡上显示的，就是将要落盘的。
 *
 * 运行：pnpm build && node --test tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HITL_CONFIG,
  appendLeafMount,
  cleanupMount,
  mountHitl,
  normalizeHitlConfig,
  organizeInsertMount,
  organizeMoveMount,
  updateIndexMount,
} from "../dist/hitl.js";
import { normalizeConfig } from "../dist/index.js";
import { insertNode } from "../dist/markdown.js";

/** 一份最小的知识树：正文一个节点 + 待整理区两片叶子。 */
const DOC = [
  "# Python",
  "",
  "## 基础",
  "",
  "### 变量",
  "",
  "变量是名字到值的绑定。",
  "",
  "## 🍂 待整理",
  "",
  "### [2026/8/27] 深拷贝与浅拷贝",
  "",
  "浅拷贝只复制第一层。",
  "",
  "### [2026/8/28] 生成器",
  "",
  "生成器是惰性的。",
  "",
].join("\n");

/** 一次挂载所需的依赖：`tree` 就是"磁盘上的"内容，null 表示文件不存在。 */
function deps({ tree = DOC, config = {} } = {}) {
  return {
    config: { ...DEFAULT_HITL_CONFIG, ...config },
    readTree: async () => tree,
  };
}

/** 假的服务：只记录被挂载的卡，不做门禁。 */
function recordingService() {
  const mounts = [];
  return {
    mounts,
    protect(matcher, options, owner) {
      mounts.push({ matcher, options, owner });
      return () => {};
    },
    unprotect: () => 0,
    list: () => [],
    pending: () => [],
  };
}

/** 一次待决策的调用：解析器只用到 name 与 arguments。 */
function execOf(name, args) {
  return { name, callId: "call_1", arguments: args };
}

/** 取卡上的某个字段，缺了就报出来——比 `undefined.value` 好读。 */
function fieldOf(mount, param) {
  const field = (mount.fields ?? []).find(entry => entry.param === param);
  assert.notEqual(field, undefined, `卡上没有 ${param} 字段`);
  return field;
}

// ── 挂载清单 ──────────────────────────────────────────────

test("挂载顺序：兜底卡先注册，两种具体形态后注册覆盖它", () => {
  const service = recordingService();
  const mounted = mountHitl(service, deps(), "owner");

  assert.deepEqual(mounted, [
    "organize_tree",
    "organize_tree(insert_node)",
    "organize_tree(move_node)",
    "append_leaf",
    "update_index",
    "cleanup_organized_leaf",
  ]);
  assert.equal(service.mounts.length, 6);
  assert.equal(service.mounts[0].options.title, "整理知识树");

  const [, insert, move] = service.mounts;
  assert.equal(insert.matcher(execOf("organize_tree", { op: "insert_node" })), true);
  assert.equal(insert.matcher(execOf("organize_tree", { op: "move_node" })), false);
  assert.equal(move.matcher(execOf("organize_tree", { op: "move_node" })), true);
  // 谓词认的是"这个工具 + 这个 op"，别的工具不会被误伤
  assert.equal(insert.matcher(execOf("append_leaf", { op: "insert_node" })), false);

  // owner 必须带下去：挂载记在 dsh-hitl 里，只有 effect 才能自动解绑
  assert.equal(service.mounts[0].owner, "owner");
});

test("enabled: false 时不挂任何卡", () => {
  const service = recordingService();
  assert.deepEqual(mountHitl(service, deps({ config: { enabled: false } })), []);
  assert.equal(service.mounts.length, 0);
});

test("共用行为合并进每张卡，卡自己的反馈提示语不丢", () => {
  const service = recordingService();
  mountHitl(service, deps({ config: { whenUnavailable: "wait", countdownSeconds: 30 } }));

  for (const { options } of service.mounts) {
    assert.equal(options.whenUnavailable, "wait");
    assert.deepEqual(options.countdown, { seconds: 30, action: "reject" });
    assert.equal(options.reject.feedback, true);
  }
  const cleanup = service.mounts.at(-1).options;
  assert.equal(cleanup.reject.feedbackPrompt, "例如：这片还没进正文，先别删");
});

// ── 四张卡的字段 ──────────────────────────────────────────

test("append_leaf：文件 → 名称 → 正文，三个参数都可编辑", () => {
  const mount = appendLeafMount();
  const content = fieldOf(mount, "content");
  assert.equal(content.render, "markdown");
  assert.match(content.description, /修改/);
  assert.deepEqual(
    mount.fields.map(field => [field.param, field.render, field.editable]),
    [
      // editable 缺省 = 可编辑：人改完点【修改】，模型拿改动重新提交
      ["path", "text", undefined],
      ["tree_name", "text", undefined],
      ["content", "markdown", undefined],
    ],
  );
});

test("四张卡：可改的给输入框、预览只读，且参数排在预览之前", () => {
  const insert = organizeInsertMount(deps());
  const move = organizeMoveMount(deps());
  const index = updateIndexMount(deps());
  const cleanup = cleanupMount(deps());

  // 参数在前、预览在后
  assert.deepEqual(index.fields.map(field => field.param), ["content", "diff"]);
  assert.deepEqual(cleanup.fields.map(field => field.param), ["path", "leaf_heading", "removed"]);
  assert.equal(insert.fields.at(-1).param, "diff");
  assert.equal(move.fields.at(-1).param, "diff");

  // 可改的参数一律用输入框（editable 缺省即可编辑）
  assert.equal(fieldOf(move, "source_heading").editable, undefined);
  assert.equal(fieldOf(move, "anchor").editable, undefined);
  assert.equal(fieldOf(move, "new_heading").editable, undefined);
  for (const mount of [insert, index]) {
    for (const field of mount.fields.filter(entry => entry.render !== "diff")) {
      assert.equal(field.editable, undefined, `${field.param} 应当可编辑`);
    }
  }

  // 既定对象不给输入框：搬移/删除的文件，以及删除卡整张
  assert.equal(fieldOf(move, "path").editable, false);
  assert.equal(fieldOf(cleanup, "path").editable, false);
  assert.equal(fieldOf(cleanup, "leaf_heading").editable, false);

  // 预览一律只读
  assert.equal(fieldOf(index, "diff").render, "diff");
  assert.equal(fieldOf(index, "diff").editable, false);
  assert.equal(fieldOf(index, "content").render, "markdown");
});

test("cleanup：整张卡只读——只能同意或拒绝", () => {
  const mount = cleanupMount(deps());
  assert.deepEqual(mount.labels, ["不可撤销"]);
  assert.deepEqual(mount.fields.map(field => field.param), ["path", "leaf_heading", "removed"]);
  for (const field of mount.fields) {
    assert.equal(field.editable, false, `${field.param} 应当只读`);
  }
  assert.equal(fieldOf(mount, "removed").render, "markdown");
  assert.equal(typeof fieldOf(mount, "removed").value, "function");
  // 「删除之后」那个字段已经按反馈去掉了
  assert.equal(mount.fields.some(field => field.param === "remaining"), false);
});

// ── 预览与工具是否同源 ────────────────────────────────────

test("organize_tree · insert_node：diff 的 after 就是工具将要写入的全文", async () => {
  const mount = organizeInsertMount(deps());
  const diff = fieldOf(mount, "diff").diff;
  const exec = execOf("organize_tree", {
    path: "python.md",
    op: "insert_node",
    anchor: "## 基础",
    insert_at: "end",
    content: "### 装饰器\n\n装饰器是语法糖。",
  });

  assert.equal(await diff.before(exec), DOC);
  assert.equal(
    await diff.after(exec),
    insertNode(DOC, "## 基础", "### 装饰器\n\n装饰器是语法糖。", "end"),
  );
  assert.equal(diff.path(exec), "knowledge-trees/python.md");
});

test("organize_tree · move_node：预览里那片叶子确实从待整理搬进了正文", async () => {
  const diff = fieldOf(organizeMoveMount(deps()), "diff").diff;
  const exec = execOf("organize_tree", {
    path: "python.md",
    op: "move_node",
    source_heading: "### [2026/8/28] 生成器",
    anchor: "## 基础",
    insert_at: "end",
    new_heading: "### 生成器",
  });

  const after = await diff.after(exec);
  assert.equal(after.includes("### 生成器"), true);
  assert.equal(after.includes("[2026/8/28]"), false);
  assert.equal(after.includes("生成器是惰性的。"), true);
});

test("整理注定失败时，diff 不摆出整篇被删的样子", async () => {
  const diff = fieldOf(organizeInsertMount(deps()), "diff").diff;
  const exec = execOf("organize_tree", {
    path: "python.md",
    op: "insert_node",
    anchor: "## 没有这个节点",
    insert_at: "end",
    content: "### x",
  });

  const before = await diff.before(exec);
  const after = await diff.after(exec);
  assert.equal(before, DOC);
  // 原文原样保留，只在末尾追加一行说明——人看到的是"会失败"，不是"要被清空"
  assert.equal(after.startsWith(DOC.replace(/\n+$/, "")), true);
  assert.match(after, /⚠️ 这次调用会失败：未找到节点/);
});

test("organize_tree 的文件不存在时，卡上直接说这次不会写入", async () => {
  const diff = fieldOf(organizeInsertMount(deps({ tree: null })), "diff").diff;
  const exec = execOf("organize_tree", {
    path: "python.md",
    op: "insert_node",
    anchor: "## 基础",
    insert_at: "end",
    content: "### x",
  });

  assert.equal(await diff.before(exec), "");
  assert.match(await diff.after(exec), /⚠️ 文件未找到: python.md/);
});

test("update_index：before 是旧索引，after 是新索引；新文件补标题", async () => {
  const existing = "# 知识树索引\n\n- [Python](./python.md) — 语言\n";
  const exec = execOf("update_index", { content: "- [Python](./python.md) — 语言、装饰器" });

  const diff = fieldOf(updateIndexMount(deps({ tree: existing })), "diff").diff;
  assert.equal(await diff.before(exec), existing);
  assert.equal(await diff.after(exec), "- [Python](./python.md) — 语言、装饰器");
  assert.equal(diff.path(exec), "knowledge-trees/index.md");

  // 文件不存在时按同一条规则补上标题
  const missing = fieldOf(updateIndexMount(deps({ tree: null })), "diff").diff;
  assert.equal(await missing.before(exec), "");
  assert.equal(
    await missing.after(exec),
    "# 知识树索引\n\n- [Python](./python.md) — 语言、装饰器",
  );
});

test("cleanup：只读展示将要删掉的原文", async () => {
  const mount = cleanupMount(deps());
  const exec = execOf("cleanup_organized_leaf", {
    path: "python.md",
    leaf_heading: "### [2026/8/27] 深拷贝与浅拷贝",
  });

  assert.equal(
    await fieldOf(mount, "removed").value(exec),
    // 节点边界到下一个标题之前，所以末尾那个空行也在删除范围内
    "### [2026/8/27] 深拷贝与浅拷贝\n\n浅拷贝只复制第一层。\n",
  );
});

test("cleanup：正文里的同名标题不算待整理叶子，卡上说明原因", async () => {
  const mount = cleanupMount(deps());
  const exec = execOf("cleanup_organized_leaf", {
    path: "python.md",
    leaf_heading: "### 变量",
  });

  assert.match(await fieldOf(mount, "removed").value(exec), /⚠️ 待整理区里没有这片叶子/);
});

test("cleanup：文件不存在时，预览说没找到文件而不是抛异常", async () => {
  const mount = cleanupMount(deps({ tree: null }));
  const exec = execOf("cleanup_organized_leaf", {
    path: "python.md",
    leaf_heading: "### [2026/8/27] 深拷贝与浅拷贝",
  });

  assert.match(await fieldOf(mount, "removed").value(exec), /⚠️ 文件未找到: python.md/);
});

// ── 配置 ──────────────────────────────────────────────────

test("配置：非法值各自退回默认并报一句，不抛出", () => {
  const warnings = [];
  const config = normalizeHitlConfig(
    { whenUnavailable: "maybe", countdownSeconds: 0, rejectFeedback: "yes", 多余的键: 1 },
    message => warnings.push(message),
  );

  assert.deepEqual(config, DEFAULT_HITL_CONFIG);
  assert.equal(warnings.length, 4);
  assert.match(warnings.join("\n"), /不认识的键 "多余的键"/);
});

test("配置：合法值生效；缺省即「拦、fail-closed、不限时」", () => {
  assert.deepEqual(
    normalizeHitlConfig(
      { enabled: false, whenUnavailable: "wait", countdownSeconds: 30, rejectFeedback: false },
      () => {},
    ),
    { enabled: false, whenUnavailable: "wait", countdownSeconds: 30, rejectFeedback: false },
  );
  assert.deepEqual(normalizeHitlConfig(undefined, () => {}), DEFAULT_HITL_CONFIG);
});

test("旧配置：humanTurn / confirm 只警告不抛出，off 仍然意味着不拦", () => {
  const warnings = [];
  const options = normalizeConfig({ humanTurn: "all", confirm: "plan-review" }, message => warnings.push(message));
  assert.equal(options.hitl.enabled, true);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /已废弃/);

  // 旧配置里"关掉确认卡"的取值要延续：off 就是不拦
  assert.equal(normalizeConfig({ humanTurn: "off" }, () => {}).hitl.enabled, false);
  assert.equal(normalizeConfig({ confirm: "off" }, () => {}).hitl.enabled, false);
  // 但显式写了 hitl 就以 hitl 为准
  assert.equal(
    normalizeConfig({ humanTurn: "off", hitl: { enabled: true } }, () => {}).hitl.enabled,
    true,
  );

  const unknown = [];
  normalizeConfig({ 没有这个键: 1 }, message => unknown.push(message));
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /不认识的键/);
});

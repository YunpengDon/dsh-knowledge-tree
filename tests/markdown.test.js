/**
 * src/markdown.ts 的结构操作回归测试。
 *
 * 重点锁住"代码围栏内的 # 不是标题"这一条：修复前，围栏里的 `# 注释` 会被
 * 当成一级标题，导致一片树叶被静默切成两半（搬走前半段，后半段留在原地）。
 *
 * 运行：pnpm build && node --test tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PENDING_HEADING,
  findHeadingLine,
  findNodeBoundary,
  getPendingLeafCount,
  insertNode,
  moveNode,
  removeNode,
  scanFences,
} from "../dist/markdown.js";

/** 把文档拆成行，供结构函数使用。 */
const toLines = (text) => text.split("\n");

// ── 围栏扫描 ──────────────────────────────────────────────

test("scanFences：反引号围栏内的行被标记，包围栏行本身", () => {
  const lines = ["a", "```sh", "# 注释", "```", "b"];
  assert.deepEqual(scanFences(lines), [false, true, true, true, false]);
});

test("scanFences：波浪号围栏同样识别", () => {
  const lines = ["~~~yaml", "# 注释", "~~~", "tail"];
  assert.deepEqual(scanFences(lines), [true, true, true, false]);
});

test("scanFences：围栏标记行可缩进 ≤3 空格并带信息串", () => {
  const lines = ["  ```json", "# x", "  ```", "tail"];
  assert.deepEqual(scanFences(lines), [true, true, true, false]);
});

test("scanFences：四反引号围栏内的三反引号行不算闭合", () => {
  const lines = ["````md", "```", "# 仍在内", "````", "tail"];
  assert.deepEqual(scanFences(lines), [true, true, true, true, false]);
});

test("scanFences：未闭合围栏之后全部视为围栏内", () => {
  const lines = ["```", "# x", "## 也不是标题", "end"];
  assert.deepEqual(scanFences(lines), [true, true, true, true]);
});

test("scanFences：缩进 4 空格的反引号不是围栏；反引号信息串含反引号也不是围栏", () => {
  assert.deepEqual(scanFences(["    ```", "# 普通标题"]), [false, false]);
  assert.deepEqual(scanFences(["``` a`b", "# 普通标题"]), [false, false]);
});

// ── 本次 bug 的回归用例 ────────────────────────────────────

test("节点边界：围栏内的 `# 注释` 不再是节点边界", () => {
  const lines = toLines(
    [
      "# 树",
      "",
      PENDING_HEADING,
      "",
      "### [2026/1/1] 甲",
      "",
      "```sh",
      "# 1) 别把我当标题",
      "echo hi",
      "```",
      "",
      "甲的尾巴",
      "",
      "### [2026/1/2] 乙",
      "",
      "乙的内容",
      "",
    ].join("\n"),
  );
  const idx = findHeadingLine(lines, "### [2026/1/1] 甲");
  const end = findNodeBoundary(lines, idx, 3);
  assert.equal(lines[end].trim(), "### [2026/1/2] 乙");
});

test("搬移：含围栏注释的树叶整片搬走，正文一行不少", () => {
  const doc = [
    "# 树",
    "",
    "## Profile",
    "",
    "## 🍂 待整理",
    "",
    "### [2026/1/1] 甲",
    "",
    "```sh",
    "# 1) 创建",
    "dsh demo",
    "# 2) 启动",
    "dsh demo run",
    "```",
    "",
    "注意事项：结尾段落",
    "",
    "### [2026/1/2] 乙",
    "",
    "乙的内容",
    "",
  ].join("\n");

  const out = moveNode(doc, "### [2026/1/1] 甲", "## Profile", "start", "### 甲");

  // 整片树叶（含围栏、后续段落）都进了正文
  assert.ok(out.includes("### 甲"), "标题应改写为去日期后的形式");
  assert.ok(out.includes("# 1) 创建"), "围栏内容应保留");
  assert.ok(out.includes("注意事项：结尾段落"), "围栏之后的段落也必须跟着搬走");
  assert.equal(out.split("注意事项：结尾段落").length - 1, 1, "不得残留副本");

  // 搬移后正文区在待整理区之前，且甲在 Profile 章节下
  const profileIdx = out.indexOf("## Profile");
  const leafIdx = out.indexOf("### 甲");
  const pendingIdx = out.indexOf(PENDING_HEADING);
  assert.ok(profileIdx < leafIdx && leafIdx < pendingIdx);

  // 待整理区里只剩乙
  assert.equal(getPendingLeafCount(out), 1);
});

// ── 响亮失败：只在围栏里出现 ────────────────────────────────

test("查找标题：只在代码块里出现时报错，而不是照做", () => {
  const lines = toLines(["# 树", "", "```", "## 假标题", "```", ""].join("\n"));
  assert.throws(
    () => findHeadingLine(lines, "## 假标题"),
    /标题位于代码块内/,
  );
});

test("查找标题：围栏内外同名时取围栏外的那个", () => {
  const lines = toLines(
    ["```", "## 同名", "```", "", "## 同名", ""].join("\n"),
  );
  assert.equal(findHeadingLine(lines, "## 同名"), 4);
  assert.equal(findHeadingLine(lines, "## 同名", 5), -1);
});

// ── 待整理计数 ────────────────────────────────────────────

test("待整理计数：围栏内的示例树叶不计入", () => {
  const doc = [
    "# 树",
    "",
    PENDING_HEADING,
    "",
    "### [2026/1/1] 真的叶子",
    "",
    "```md",
    "### [2026/1/1] 只是示例",
    "```",
    "",
    "### [2026/1/2] 另一片真叶子",
    "",
  ].join("\n");
  assert.equal(getPendingLeafCount(doc), 2);
});

// ── 既有行为的回归 ────────────────────────────────────────

test("insertNode：start 紧贴标题之后，end 落在下一个同级标题之前", () => {
  const doc = ["# 树", "", "## A", "", "A 的内容", "", "## B", "", "B 的内容", ""].join("\n");

  const atStart = insertNode(doc, "## A", "### 新叶\n正文", "start");
  assert.ok(atStart.indexOf("### 新叶") < atStart.indexOf("A 的内容"));

  const atEnd = insertNode(doc, "## A", "### 新叶\n正文", "end");
  const insertPos = atEnd.indexOf("### 新叶");
  assert.ok(insertPos > atEnd.indexOf("A 的内容"));
  assert.ok(insertPos < atEnd.indexOf("## B"));
});

test("insertNode：接缝恰好留一个空行", () => {
  const doc = ["# 树", "", "## 待整理", "", "## B", ""].join("\n");
  const out = insertNode(doc, "## 待整理", "### 叶", "start");
  assert.ok(out.includes(`## 待整理\n\n### 叶\n\n## B`), out);
});

test("removeNode：from 之前的同名标题不受影响", () => {
  const doc = [
    "# 树",
    "",
    "## 正文",
    "",
    "### [2026/1/1] 同名",
    "",
    "正文里的内容",
    "",
    PENDING_HEADING,
    "",
    "### [2026/1/1] 同名",
    "",
    "待整理区里的内容",
    "",
  ].join("\n");

  const out = removeNode(doc, "### [2026/1/1] 同名", doc.split("\n").indexOf(PENDING_HEADING));
  assert.ok(out.includes("正文里的内容"), "正文中的同名节点必须保留");
  assert.ok(!out.includes("待整理区里的内容"), "待整理区中的节点应被删除");
});

test("moveNode：目标不能是源节点自身", () => {
  const doc = ["# 树", "", "## A", "", "内容", ""].join("\n");
  assert.throws(() => moveNode(doc, "## A", "## A", "start"), /不能是源节点自身/);
});

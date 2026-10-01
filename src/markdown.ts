/**
 * 知识树的 Markdown 结构操作（纯函数，不依赖 Cordis 上下文）。
 *
 * 这里是插件里**唯一**被允许解释"文档结构"的地方：什么算标题、一个节点到
 * 哪里结束、插入或搬移后接缝怎么留。工具实现只负责 I/O 与参数校验。
 *
 * 结构扫描必须跳过代码围栏。围栏里的 `#`（shell 注释、YAML 注释、示例
 * Markdown）不是标题；一旦当成标题，节点边界会提前收束，一片树叶会被静默
 * 切成两半——搬走的只有前半段，后半段留在原地，且不报错。
 */

/** "待整理"区域的标题。 */
export const PENDING_HEADING = "## 🍂 待整理";

/**
 * 获取 Markdown 标题层级（# 的数量）
 */
export function headingLevel(heading: string): number {
  return heading.match(/^#+/)?.[0].length ?? 0; // 计算一个 Markdown 标题字符串开头的 # 数量，也就是标题级别。正则的`^`表示字符串开头， `#+` 表示一个或多个连续的 #。；如果没有以 # 开头，就返回 0
}

/**
 * 标记每一行是否位于代码围栏内部（围栏标记行本身也算"内部"）。
 *
 * 按 CommonMark 的最小规则集识别：
 *   - 开启围栏：缩进不超过 3 个空格 + 连续 3 个及以上的 ` 或 ~；反引号围栏的
 *     信息串里不能再出现反引号（那样的行不是围栏）；
 *   - 闭合围栏：同一种字符、长度不短于开启围栏、行尾只剩空白；
 *   - 未闭合的围栏：其后所有行都算内部（保守处理；宁可少认标题，也不误切节点）。
 *
 * @param lines - 文档按行拆分后的数组。
 * @returns 与 lines 等长的布尔数组，true 表示该行处于围栏内部。
 */
export function scanFences(lines: string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false); // 初始化fenced为全false的数组，表示所有行都不在代码围栏内
  let open: { char: string; length: number } | null = null; // open 用于记录当前是否有开启的代码围栏，如果有，记录其标记字符和长度；如果没有，open为null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open === null) {
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line); // 正则匹配行首0～3个空格，后跟至少3个连续的 ` 或 ~，并捕获剩余内容
      if (match === null) continue;
      const marker = match[2]; // marker 是匹配到的围栏标记字符（` 或 ~）及其长度
      // 反引号围栏的信息串不允许再含反引号，否则这只是一行普通文本
      if (marker[0] === "`" && match[3].includes("`")) continue;
      open = { char: marker[0], length: marker.length }; // 记录开启的围栏标记字符和长度
      fenced[i] = true;
    } else {
      fenced[i] = true; // 如果之前的循环中围栏的标记open不为null，说明当前行在代码围栏内，将fenced[i]标记为true
      const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line); // 正则匹配行首0～3个空格，后跟至少3个连续的 ` 或 ~，并捕获剩余内容
      // 如果匹配成功+匹配到的围栏标记字符与开启的围栏标记字符相同+长度不短于开启的围栏标记长度，则说明当前行是围栏闭合行，将open置为null
      if (
        match !== null && // 匹配成功
        match[2][0] === open.char && // 匹配到的围栏标记字符与开启的围栏标记字符相同
        match[2].length >= open.length // 匹配到的围栏标记长度不短于开启的围栏标记长度
      ) {
        open = null;
      }
    }
  }
  return fenced;
}

/**
 * 该行是否是结构意义上的标题（围栏内的行一律不是）。
 *
 * 这是插件里"什么算标题"的唯一定义：结构扫描全部走这里，避免各处各写一份
 * 正则而互相跑偏。
 */
export function isHeadingLine(
  lines: string[],
  index: number,
  fenced: boolean[],
): boolean {
  return !fenced[index] && /^#{1,6}\s/.test(lines[index].trim());
}

/**
 * 在 md_text 中找到指定标题所在行号，找不到返回 -1
 *
 * 只认围栏外的标题。若该标题**只**出现在代码围栏里，说明调用方把围栏内的
 * 内容当成了结构节点，直接报错而不是照着搬——响亮失败优于静默搬错。
 *
 * @param from - 起始行号（含），用于只在某个区域内查找（如"待整理"区之后）。
 */
export function findHeadingLine(
  lines: string[],
  heading: string,
  from = 0,
): number {
  const wanted = heading.trim();
  const fenced = scanFences(lines);
  let hitInsideFence = false;
  for (let i = Math.max(from, 0); i < lines.length; i++) {
    if (lines[i].trim() !== wanted) continue;
    if (!fenced[i]) {
      return i;
    } else {
      hitInsideFence = true;
    }
  }
  if (hitInsideFence) {
    throw new Error(`标题位于代码块内，不能作为结构节点: ${wanted}`);
  }
  return -1;
}

/**
 * 从 startIdx+1 开始，找到下一个同级或更高级标题的行号
 * （即当前节点内容的边界），找不到返回 lines.length
 */
export function findNodeBoundary(
  lines: string[],
  startIdx: number, // 开始查询的行号
  level: number,
): number {
  const fenced = scanFences(lines);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (fenced[j]) continue; // 如果当前行在代码围栏内，跳过该行
    if (
      isHeadingLine(lines, j, fenced) &&
      headingLevel(lines[j].trim()) <= level // 如果当前行是标题行，并且标题级别小于等于给定的 level，那么说明找到了下一个同级或更高级标题的行号
    ) {
      return j;
    }
  }
  return lines.length; // 如果没有找到下一个同级或更高级标题的行号，返回 lines.length，表示当前节点内容的边界是文档末尾
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
export function insertNode(
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
export function moveNode(
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
  if (
    targetIdx === sourceIdx ||
    (targetIdx > sourceIdx && targetIdx < endIdx)
  ) {
    throw new Error(`目标节点不能是源节点自身或其子节点: ${targetHeading}`);
  }

  const sourceLines = lines.slice(sourceIdx, endIdx); // 提取源节点内容（标题 + 正文，到下一个同级/更高级标题之前）
  if (newHeading !== undefined) {
    const trimmedNewHeading = newHeading.trim();
    if (/\n/.test(trimmedNewHeading) || !/^#{1,6}\s+\S/.test(trimmedNewHeading)) {
      throw new Error(`new_heading 必须是单行标题，例如 "### 标题"`);
    }
    sourceLines[0] = trimmedNewHeading;
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
 * 删除一个节点（标题 + 正文），返回删除后的文档。
 *
 * @param from - 起始行号（含）；cleanup 用它把查找限制在"待整理"区之后，
 * 避免正文里同名标题被误删。
 */
export function removeNode(mdText: string, heading: string, from = 0): string {
  const lines = mdText.split("\n");
  const idx = findHeadingLine(lines, heading, from);
  if (idx === -1) throw new Error(`未找到节点: ${heading}`);

  const endIdx = findNodeBoundary(lines, idx, headingLevel(heading));
  lines.splice(idx, endIdx - idx);
  return lines.join("\n");
}

/**
 * 统计"## 🍂 待整理"区域下的叶子节点数量
 * 叶子节点格式：### [日期] 标题
 *
 * 围栏内的示例标题不计入——它们只是被贴进正文的样例。
 */
export function getPendingLeafCount(mdText: string): number {
  const lines = mdText.split("\n");
  const pendingIdx = findHeadingLine(lines, PENDING_HEADING);
  if (pendingIdx === -1) throw new Error("未找到待整理区域");

  const fenced = scanFences(lines);
  let count = 0;
  for (let j = pendingIdx + 1; j < lines.length; j++) {
    if (fenced[j]) continue;
    if (/^### \[\d/.test(lines[j].trim())) count++;
  }
  return count;
}

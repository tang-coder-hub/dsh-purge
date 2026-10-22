/**
 * 回归：marker 迁移之后，needle 侧也必须归一化。
 *
 * 背景（真实故障）：宿主文件在第一次 apply 时被 normalizeMarks 把旧标记 "[dsh-purge]"
 * 改成 "[cfg]"。之后补丁表里那些 needle 仍写着旧标记的变体就再也匹配不上了：
 *   - patchHasRemainingWork() 归一化了 needle → 认为"还有活"，
 *   - applyReplacementsToText() 没归一化 needle → 永远匹配不上、什么也没写，
 * 结果补丁永远卡在 pending，每轮重试都是空转。线上表现就是 #87 HUNG_PROMPT_LF_NEEDLE 一直 pending。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyReplacementsToText, applyPatches, patchApplied, ALL_PATCHES } from "../lib/core.js";
import { makeTmpRoot, cleanupTmpRoot, makeHost, writeFile } from "./helpers.mjs";
import path from "node:path";

/** needle 里写旧标记、产物写中性标记的合成补丁。 */
const LEGACY_NEEDLE_PATCH = {
  id: 9101,
  name: "TEST_LEGACY_NEEDLE",
  file: "agent-instructions",
  rel: ["lib", "index.js"],
  skipIfMarked: true,
  markers: ["[cfg] needle migrated"],
  replacements: [
    {
      pattern: "const OLD = 1; // [dsh-purge] needle marker",
      replace: "const OLD = 1; // [cfg] needle migrated",
    },
  ],
};

test("needle 写旧标记，也能命中已经被迁移成 [cfg] 的文本", () => {
  const alreadyMigrated = "const OLD = 1; // [cfg] needle marker\n";
  const { text, changed } = applyReplacementsToText(alreadyMigrated, LEGACY_NEEDLE_PATCH, "x.js");

  assert.equal(changed, true, "迁移后的文本里 needle 仍应命中（needle 侧要过 normalizeMarks）");
  assert.ok(text.includes("// [cfg] needle migrated"));
  assert.equal(patchApplied(text, LEGACY_NEEDLE_PATCH), true);
});

test("needle 归一化后幂等：第二次不再改动", () => {
  const once = applyReplacementsToText("const OLD = 1; // [cfg] needle marker\n", LEGACY_NEEDLE_PATCH, "x.js");
  const twice = applyReplacementsToText(once.text, LEGACY_NEEDLE_PATCH, "x.js");

  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test("needle 里没有标记时行为不变（不能因为归一化而误命中）", () => {
  const other = "const OLD = 1; // something else\n";
  const { changed, text } = applyReplacementsToText(other, LEGACY_NEEDLE_PATCH, "x.js");
  assert.equal(changed, false);
  assert.equal(text, other);
});

/**
 * #87 第 9 个变体的端到端回归：宿主文件里已经是 [cfg] 形态（迁移之后的样子），
 * 前 8 个变体的 needle 都写着旧标记，只有第 9 个能命中。
 */
const HUNG_BLOCK_CFG_FORM = [
  "\tasync step(decision) {",
  "\t\tconst { assembly } = decision;",
  "\t\tlet renderedPrompt = renderPrompt(assembly);",
  '\t\tconst dshPurgeHung = typeof globalThis.__dshPurgeHungPrompt === "function" ? String(globalThis.__dshPurgeHungPrompt() || "").trim() : "";',
  "\t\tconst dshPurgeTail = dshPurgeHung.slice(-96);",
  '\t\tif (dshPurgeHung && (!dshPurgeTail || !String(renderedPrompt || "").includes(dshPurgeTail))) {',
  '\t\t\trenderedPrompt = dshPurgeHung + (renderedPrompt ? "\\n\\n" + renderedPrompt : ""); // [cfg] hang full prompt-inject at head',
  "\t\t}",
  "\t}",
  "",
].join("\n");

test("#87 在 [cfg] 形态的宿主文件上能应用，且不重复注入", async () => {
  const root = makeTmpRoot("dsh-purge-hung87");
  try {
    const base = makeHost(root, "host-a");
    const agentLoop = path.join(base, "dsh-agent-loop", "lib", "index.js");
    writeFile(agentLoop, HUNG_BLOCK_CFG_FORM);

    const p87 = ALL_PATCHES.find((p) => p.id === 87);
    assert.equal(p87.replacements.length >= 9, true, "#87 应该有第 9 个变体");
    assert.equal(patchApplied(HUNG_BLOCK_CFG_FORM, p87), false, "应用前不该算已应用");

    const first = await applyPatches(base, [p87], { autoBackup: false });
    const row = first.find((r) => r.patch_id === 87) ?? first[0];
    assert.equal(row.status, "applied");

    const afterFirst = (await import("node:fs")).readFileSync(agentLoop, "utf8");
    assert.ok(afterFirst.includes("[dsh-purge-87] hang needle uses LF"), "应写入中性 LF 比对版本");
    assert.ok(afterFirst.includes("dshPurgeHead"), "应换成头尾双向比对");
    assert.equal(afterFirst.includes("[cfg] hang full prompt-inject at head"), false, "旧行应被替换掉");
    assert.equal(patchApplied(afterFirst, p87), true);

    const second = await applyPatches(base, [p87], { autoBackup: false });
    const row2 = second.find((r) => r.patch_id === 87) ?? second[0];
    assert.equal(row2.status, "already");

    const afterSecond = (await import("node:fs")).readFileSync(agentLoop, "utf8");
    assert.equal(afterSecond, afterFirst, "重复 apply 必须字节不变");
    assert.equal((afterSecond.match(/dshPurgeHead/g) || []).length, 3, "不能重复注入");
  } finally {
    cleanupTmpRoot(root);
  }
});

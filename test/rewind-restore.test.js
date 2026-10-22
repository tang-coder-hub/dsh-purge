// 场景二：rewind 还原。
//
// 「还原」有两层含义，这里都测：
//   (a) 宿主文件层面 —— 打完补丁的宿主能从 .dshpurge.bak 还原回原件，
//       文件丢了/被写成 0 字节也能从 bak 救回来；
//   (b) 对话层面 —— lib/rewind.js 的回退规划纯函数（不依赖 DSH ctx）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";

import {
  AGENT_INSTRUCTIONS_ORIGINAL,
  IDEMPOTENT_PATCH,
  cleanupTmpRoot,
  hostFile,
  makeHost,
  makeTmpRoot,
} from "./helpers.mjs";

import {
  applyPatches,
  restoreMissingOriginalsFromBak,
  revertAll,
} from "../lib/core.js";

import {
  cutSurfaceNodes,
  isRewindDerivedMessage,
  lastHumanUserText,
  lastTurnSubagentIds,
  pendingInboxInserts,
  planRewind,
} from "../lib/rewind.js";

describe("rewind 还原 · 宿主文件回滚", () => {
  let root = "";
  let base = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-rewind");
    base = makeHost(root, "host-rewind");
  });

  after(() => cleanupTmpRoot(root));

  it("打完补丁后能还原回原件，且备份被清掉", async () => {
    const fp = hostFile(base);
    const original = fs.readFileSync(fp, "utf8");
    assert.equal(original, AGENT_INSTRUCTIONS_ORIGINAL);

    await applyPatches(base, [IDEMPOTENT_PATCH]);
    const patched = fs.readFileSync(fp, "utf8");
    assert.notEqual(patched, original, "补丁应该改过文件");
    assert.ok(patched.includes("[cfg] TEST_IDEMPOTENT"));
    assert.ok(fs.existsSync(`${fp}.dshpurge.bak`), "备份文件应该存在");

    const result = await revertAll(base);
    assert.ok(result.reverted.includes(fp), `应回滚 ${fp}，实际 ${JSON.stringify(result.reverted)}`);
    assert.equal(fs.readFileSync(fp, "utf8"), original, "还原后必须与原件逐字节相同");
    assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), false, "回滚后备份应被删除");
  });

  it("没有备份时 revertAll 只跳过，绝不删宿主文件", async () => {
    const fp = hostFile(base);
    const current = fs.readFileSync(fp, "utf8");
    const result = await revertAll(base);
    assert.ok(result.skipped.includes(fp));
    assert.ok(result.reverted.length === 0);
    assert.equal(fs.readFileSync(fp, "utf8"), current, "没有 bak 时文件必须原样保留");
  });

  it("文件被删/写成 0 字节时，能从 bak 救回来（bak 保留不删）", async () => {
    const fp = hostFile(base);
    await applyPatches(base, [IDEMPOTENT_PATCH]);
    const bak = `${fp}.dshpurge.bak`;
    assert.ok(fs.existsSync(bak));
    const bakText = fs.readFileSync(bak, "utf8");

    // 情形一：文件整个不见了
    fs.unlinkSync(fp);
    assert.equal(fs.existsSync(fp), false);
    const restoredMissing = restoreMissingOriginalsFromBak(base);
    assert.ok(restoredMissing.includes(fp), "缺失的正式文件应从 bak 拷回");
    assert.equal(fs.readFileSync(fp, "utf8"), bakText);
    assert.ok(fs.existsSync(bak), "救回原件后 bak 仍在");

    // 情形二：文件被写成 0 字节
    fs.writeFileSync(fp, "");
    const restoredEmpty = restoreMissingOriginalsFromBak(base);
    assert.ok(restoredEmpty.includes(fp), "0 字节文件应从 bak 拷回");
    assert.equal(fs.readFileSync(fp, "utf8"), bakText);
  });
});

describe("rewind 还原 · 对话回退规划", () => {
  const events = [
    { seq: 1, type: "user/message", data: { id: "m1", source: { kind: "user" }, content: "第一句" } },
    { seq: 2, type: "turn/start", data: { turn: 1 } },
    { seq: 3, type: "assistant/message", data: {} },
    { seq: 4, type: "turn/end", data: { turn: 1 } },
    { seq: 5, type: "user/message", data: { id: "m2", source: { kind: "user" }, content: "第二句" } },
    { seq: 6, type: "turn/start", data: { turn: 2 } },
    { seq: 7, type: "turn/end", data: { turn: 2 } },
  ];

  it("planRewind 指向最近一轮闭合的那句", () => {
    const plan = planRewind(events);
    assert.equal(plan.ok, true);
    assert.equal(plan.mode, "input");
    assert.equal(plan.text, "第二句");
    assert.equal(plan.fromSeq, 6, "fromSeq 应落在最后一轮的 turn/start");
  });

  it("没有可回退的上一句时如实报错", () => {
    const plan = planRewind([]);
    assert.equal(plan.ok, false);
    assert.equal(plan.error, "没有可回退的上一句");
  });

  it("回退标记不算可回退的目标", () => {
    const withMarker = [
      ...events,
      { seq: 8, type: "user/message", data: { id: "rewind-1700000000", content: "" } },
    ];
    const plan = planRewind(withMarker);
    assert.equal(plan.ok, true);
    assert.equal(plan.text, "第二句", "rewind- 标记不能被当成用户输入回退");
  });

  it("cutSurfaceNodes 只切 fromSeq 之后的节点，且不动节点 0 的系统提示", () => {
    const nodes = [0, 1, 2, 3];
    const lookup = (seq) => ({
      0: { type: "system/message" },
      1: { type: "user/message", data: { id: "m1" } },
      2: { type: "user/message", data: { id: "m2" } },
      3: { type: "assistant/message" },
    })[seq];

    assert.deepEqual(cutSurfaceNodes(nodes, 2, lookup), [2, 3]);
    assert.deepEqual(cutSurfaceNodes(nodes, 0, lookup), [1, 2, 3], "系统提示所在的节点 0 不能被切");
    assert.deepEqual(cutSurfaceNodes(nodes, 9, lookup), [], "fromSeq 之后没有节点就什么都不切");
  });

  it("cutSurfaceNodes 会连带吃掉前面的回退空标记", () => {
    const nodes = [0, 1, 2, 3];
    const lookup = (seq) => ({
      0: { type: "system/message" },
      1: { type: "user/message", data: { id: "rewind-1700000000" } },
      2: { type: "user/message", data: { id: "m2" } },
      3: { type: "assistant/message" },
    })[seq];

    assert.deepEqual(cutSurfaceNodes(nodes, 2, lookup), [1, 2, 3], "回退标记节点要一起清掉");
  });

  it("isRewindDerivedMessage 认得回退派生消息", () => {
    assert.equal(isRewindDerivedMessage({ id: "rewind-123" }), true);
    assert.equal(isRewindDerivedMessage({ id: "m1" }), false);
  });

  it("pendingInboxInserts 只取最后一轮之后插入的消息", () => {
    const spliced = [
      ...events,
      {
        seq: 8,
        type: "agent/inbox/spliced",
        data: { target: "next-turn", inserted: [{ id: "x1" }, { id: "x2" }] },
      },
      {
        seq: 9,
        type: "agent/inbox/spliced",
        data: { target: "other-session", inserted: [{ id: "y1" }] },
      },
    ];
    assert.deepEqual(pendingInboxInserts(spliced), ["x1", "x2"]);
    assert.deepEqual(pendingInboxInserts(events), []);
  });

  it("lastTurnSubagentIds 按 fromSeq 收集子会话 id", () => {
    const withSub = [
      ...events,
      { seq: 8, type: "subagent/catalog", data: { childId: "sub-1" } },
      { seq: 9, type: "subagent/descriptor", data: { sessionId: "sub-2" } },
    ];
    assert.deepEqual(lastTurnSubagentIds(withSub, 0), ["sub-1", "sub-2"]);
    assert.deepEqual(lastTurnSubagentIds(withSub, 8), ["sub-1", "sub-2"]);
    assert.deepEqual(lastTurnSubagentIds(withSub, 9), ["sub-2"]);
  });

  it("lastHumanUserText 取最后一句真人输入", () => {
    assert.equal(lastHumanUserText(events), "第二句");
    assert.equal(
      lastHumanUserText([
        ...events,
        { seq: 8, type: "user/message", data: { id: "p1", source: { kind: "plugin" }, content: "[MNEMON] 草稿" } },
      ]),
      "第二句",
      "插件草稿不算真人输入",
    );
  });
});

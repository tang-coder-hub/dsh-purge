// 场景三：清洗覆盖全部宿主。
//
// 上游 #40 就是「清洗没有写进全部宿主」——Web 宿主洗了、桌面宿主没洗。
// 这里用 options.bases 注入点喂两个假宿主，断言：两个宿主都真的写进去了、
// 重复宿主会去重、合并报告取最差状态、一个宿主失败不会拖累另一个。
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";

import {
  AGENT_INSTRUCTIONS_ORIGINAL,
  IDEMPOTENT_PATCH,
  STRICT_IDEMPOTENT_PATCH,
  SYSTEM_PROMPT_DIRTY,
  cleanupTmpRoot,
  hostFile,
  hostSystemPromptFile,
  makeHost,
  makeTmpRoot,
} from "./helpers.mjs";

import {
  allPatchHostsWritten,
  applyPatchesAllHosts,
  mergeApplyReports,
  revertAllHosts,
} from "../lib/core.js";

const APPLY_OPTS = { silenceFlash: false };

describe("清洗全部宿主 · 多宿主写入", () => {
  let root = "";
  let hostA = "";
  let hostB = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-hosts");
    hostA = makeHost(root, "host-a");
    hostB = makeHost(root, "host-b");
  });

  after(() => cleanupTmpRoot(root));

  it("两个宿主都被写进去了，不是只洗第一个", async () => {
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [hostA, hostB],
    });

    assert.equal(result.hosts.length, 2, "两个宿主都应在结果里");
    for (const base of [hostA, hostB]) {
      const text = fs.readFileSync(hostFile(base), "utf8");
      assert.ok(text.includes("[cfg] TEST_IDEMPOTENT"), `${base} 没被清洗`);
    }
    assert.ok(fs.existsSync(`${hostFile(hostA)}.dshpurge.bak`), "每个宿主都要有备份");
    assert.ok(fs.existsSync(`${hostFile(hostB)}.dshpurge.bak`), "每个宿主都要有备份");
  });

  it("每个宿主的 hostWritten 标记都为真，allPatchHostsWritten 成立", async () => {
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [hostA, hostB],
    });
    for (const host of result.hosts) {
      assert.equal(host.hostWritten, true, `${host.aiBase} 的清洗标记没认出来`);
    }
    assert.equal(allPatchHostsWritten(result.hosts), true);
  });

  it("重复传入同一个宿主只会洗一次", async () => {
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [hostA, hostA],
    });
    assert.equal(result.hosts.length, 1, "同一个宿主不能出现两次");
  });

  it("合并报告按 patch_id 去重，同一补丁只留一行", async () => {
    // 用全新夹具：前面几轮已经把 hostA/hostB 洗过一遍，状态会是 already，这里要验的是「首次清洗」。
    const freshRoot = makeTmpRoot("dsh-purge-merge");
    try {
      const freshA = makeHost(freshRoot, "host-a");
      const freshB = makeHost(freshRoot, "host-b");
      const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
        ...APPLY_OPTS,
        bases: [freshA, freshB],
      });
      const ids = result.report.map((row) => row.patch_id);
      assert.deepEqual(ids, [IDEMPOTENT_PATCH.id]);
      assert.equal(result.report[0].status, "applied");
    } finally {
      cleanupTmpRoot(freshRoot);
    }
  });

  it("重复清洗时状态变成 already（第二轮不再改文件）", async () => {
    const before = fs.readFileSync(hostFile(hostA));
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [hostA, hostB],
    });
    assert.equal(result.report[0].status, "already");
    assert.ok(fs.readFileSync(hostFile(hostA)).equals(before), "第二轮不得改字节");
  });

  it("一个宿主洗不动时，另一个宿主照洗不误", async () => {
    const bad = makeHost(root, "host-bad", { agentInstructions: "const NOTHING_HERE = 1;\n" });
    const result = await applyPatchesAllHosts([STRICT_IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [bad, hostB],
    });

    assert.equal(result.hosts.length, 2);
    const badHost = result.hosts.find((h) => h.aiBase === bad);
    const goodHost = result.hosts.find((h) => h.aiBase === hostB);
    assert.equal(badHost.report[0].status, "pattern_not_found", "pattern 没命中就该如实报");
    assert.equal(goodHost.report[0].status, "already", "好宿主不该被坏宿主拖累");
  });

  it("宿主缺清洗标记时 hostWritten 为假，allPatchHostsWritten 也就为假", async () => {
    const dirty = makeHost(root, "host-dirty", { systemPrompt: SYSTEM_PROMPT_DIRTY });
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [dirty],
    });
    assert.equal(result.hosts[0].hostWritten, false, "system-prompt 不对就不能算洗干净");
    assert.equal(allPatchHostsWritten(result.hosts), false);
    assert.ok(fs.existsSync(hostSystemPromptFile(dirty)), "只是判定，不该动文件");
  });
});

describe("清洗全部宿主 · 报告合并规则", () => {
  it("同一补丁取各宿主里最差的状态", () => {
    const merged = mergeApplyReports([
      [{ patch_id: 7, name: "P7", status: "applied" }],
      [{ patch_id: 7, name: "P7", status: "failed" }],
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, "failed", "applied + failed 必须取 failed");
  });

  it("不同补丁各留一行，按 id 排序", () => {
    const merged = mergeApplyReports([
      [{ patch_id: 9, name: "P9", status: "applied" }],
      [{ patch_id: 3, name: "P3", status: "already" }],
    ]);
    assert.deepEqual(merged.map((row) => row.patch_id), [3, 9]);
  });

  it("空宿主列表不算全部写完", () => {
    assert.equal(allPatchHostsWritten([]), false);
    assert.equal(allPatchHostsWritten(null), false);
    assert.equal(allPatchHostsWritten([{ hostWritten: true }]), true);
    assert.equal(allPatchHostsWritten([{ hostWritten: true }, { hostWritten: false }]), false);
  });
});

describe("清洗全部宿主 · 全宿主回滚", () => {
  let root = "";
  let hostA = "";
  let hostB = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-revert-all");
    hostA = makeHost(root, "host-a");
    hostB = makeHost(root, "host-b");
  });

  after(() => cleanupTmpRoot(root));

  it("revertAllHosts 把所有宿主都还原回原件", async () => {
    await applyPatchesAllHosts([IDEMPOTENT_PATCH], { ...APPLY_OPTS, bases: [hostA, hostB] });
    assert.ok(fs.readFileSync(hostFile(hostA), "utf8").includes("[cfg] TEST_IDEMPOTENT"));
    assert.ok(fs.readFileSync(hostFile(hostB), "utf8").includes("[cfg] TEST_IDEMPOTENT"));

    const result = await revertAllHosts({ bases: [hostA, hostB] });
    assert.equal(result.errors.length, 0, `回滚不该有错误：${JSON.stringify(result.errors)}`);
    assert.equal(result.reverted.length, 2, "两个宿主都要被回滚");
    assert.equal(fs.readFileSync(hostFile(hostA), "utf8"), AGENT_INSTRUCTIONS_ORIGINAL);
    assert.equal(fs.readFileSync(hostFile(hostB), "utf8"), AGENT_INSTRUCTIONS_ORIGINAL);
    assert.equal(fs.existsSync(`${hostFile(hostA)}.dshpurge.bak`), false);
    assert.equal(fs.existsSync(`${hostFile(hostB)}.dshpurge.bak`), false);
  });

  it("再回滚一次不报错也不动文件（bak 已经没了）", async () => {
    const result = await revertAllHosts({ bases: [hostA, hostB] });
    assert.equal(result.errors.length, 0);
    assert.equal(result.reverted.length, 0);
    assert.equal(fs.readFileSync(hostFile(hostA), "utf8"), AGENT_INSTRUCTIONS_ORIGINAL);
  });
});

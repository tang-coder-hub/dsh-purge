// 场景四：写宿主之前先拍快照，出问题能搬回去。
//
// 用户要的是「自动重打补丁做默认，但写之前先备份一份，出问题能回滚」。
// 已有的 .dshpurge.bak 解决不了这件事：逐文件、散在几十个目录、revertAll 之后还会被吃掉。
// 所以 applyPatchesAllHosts 在 backupAll 之前先拍一份整包宿主快照，拍不出来就不写。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  AGENT_INSTRUCTIONS_ORIGINAL,
  IDEMPOTENT_PATCH,
  cleanupTmpRoot,
  hostFile,
  makeHost,
  makeTmpRoot,
  sandboxHome,
} from "./helpers.mjs";

import { applyPatchesAllHosts } from "../lib/core.js";
import {
  DEFAULT_HOST_KEEP,
  hostSnapshotsRoot,
  listHostSnapshots,
  restoreHostSnapshot,
} from "../lib/host-snapshot.js";

const APPLY_OPTS = { silenceFlash: false };

describe("写宿主前拍快照 · 回滚兜底", () => {
  let root = "";
  let hostA = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-hsnap");
    hostA = makeHost(root, "host-a");
  });

  after(() => cleanupTmpRoot(root));

  it("写完宿主后能列出快照，manifest 里记的是补丁前的路径", async () => {
    const before = listHostSnapshots(sandboxHome()).length;
    const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
      ...APPLY_OPTS,
      bases: [hostA],
      dshHome: sandboxHome(),
      snapshotReason: "unit-test",
    });

    assert.equal(result.snapshotFailures.length, 0, "不该有快照失败");
    assert.equal(result.hosts[0].snapshotError, undefined);
    assert.match(String(result.hosts[0].snapshot), /^\d{8}-\d{6}-\d{3}/, "结果里要带快照号");

    const rows = listHostSnapshots(sandboxHome());
    assert.equal(rows.length, before + 1, "应该多一份快照");
    const latest = rows[0];
    assert.equal(latest.reason, "unit-test");
    assert.ok(latest.files >= 2, "至少两份宿主文件进了快照");
    assert.ok(latest.inside.includes("dsh-agent-instructions/lib/index.js"), "相对路径按 aiBase 记");
  });

  it("快照里存的是补丁前的原文，不是打完的样子", async () => {
    const snap = listHostSnapshots(sandboxHome())[0];
    const copy = path.join(
      hostSnapshotsRoot(sandboxHome()),
      snap.stamp,
      "files",
      "inside",
      "dsh-agent-instructions",
      "lib",
      "index.js",
    );
    const saved = fs.readFileSync(copy, "utf8");
    assert.ok(!saved.includes("[cfg] TEST_IDEMPOTENT"), "快照必须是打补丁之前的内容");
    assert.ok(saved.includes("The following workspace instructions may be relevant"));
  });

  it("快照失败就不动宿主，宁可这次不打也不留半新半旧", async () => {
    const bare = makeTmpRoot("dsh-purge-hsnap-bad");
    try {
      const hostB = makeHost(bare, "host-b");
      // 把 host-snapshots 位置先占成一个普通文件，mkdir 必然失败。
      const blocked = path.join(bare, "dsh-purge");
      fs.mkdirSync(blocked, { recursive: true });
      fs.writeFileSync(path.join(blocked, "host-snapshots"), "not a dir", "utf8");

      const beforeText = fs.readFileSync(hostFile(hostB), "utf8");
      const result = await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
        ...APPLY_OPTS,
        bases: [hostB],
        dshHome: bare,
      });

      assert.equal(result.snapshotFailures.length, 1, "应该报出快照失败");
      assert.equal(result.hosts[0].hostWritten, false);
      assert.equal(fs.readFileSync(hostFile(hostB), "utf8"), beforeText, "宿主必须原封不动");
      assert.ok(!fs.existsSync(`${hostFile(hostB)}.dshpurge.bak`), "没拍成快照就不该去碰备份");
    } finally {
      cleanupTmpRoot(bare);
    }
  });

  it("restoreHostSnapshot 能把改坏的宿主搬回去，且不删 aiBase 里别的文件", async () => {
    const snap = listHostSnapshots(sandboxHome())[0];
    const extra = path.join(hostA, "dsh-agent-instructions", "lib", "keep-me.js");
    fs.writeFileSync(extra, "// 快照里没有这个文件，还原也不该删它\n", "utf8");
    fs.writeFileSync(hostFile(hostA), "// 被改坏了\n", "utf8");

    const back = restoreHostSnapshot(snap.stamp, { aiBase: hostA, dshHome: sandboxHome() });
    assert.equal(back.ok, true, back.error);
    assert.ok(Array.isArray(back.restored) && back.restored.length >= 1, "至少要还原一个文件");

    const text = fs.readFileSync(hostFile(hostA), "utf8");
    assert.equal(text, AGENT_INSTRUCTIONS_ORIGINAL, "内容要回到快照那一刻");
    assert.ok(fs.existsSync(extra), "只覆盖不删除，别的文件不能被顺手清掉");
  });

  it("留几份由 hostKeep 控制，多打的会被修剪掉", async () => {
    const keep = 2;
    for (let i = 0; i < 4; i += 1) {
      await applyPatchesAllHosts([IDEMPOTENT_PATCH], {
        ...APPLY_OPTS,
        bases: [hostA],
        dshHome: sandboxHome(),
        hostKeep: keep,
      });
    }
    const rows = listHostSnapshots(sandboxHome());
    assert.ok(rows.length <= keep, `应只留 ${keep} 份，实际 ${rows.length}`);
    assert.ok(rows.length >= 1);
    assert.equal(DEFAULT_HOST_KEEP, 3);
  });
});

// 宿主文件回滚：打完补丁的宿主能从 .dshpurge.bak 还原回原件，
// 文件丢了 / 被写成 0 字节也能从 bak 救回来。

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


describe("宿主文件回滚 · bak 还原", () => {
  let root = "";
  let base = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-bak");
    base = makeHost(root, "host-bak");
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
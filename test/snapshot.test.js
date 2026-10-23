import "./helpers.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanupTmpRoot, makeTmpRoot, sandboxHome, writeFile } from "./helpers.mjs";
import {
  DEFAULT_KEEP,
  createSnapshot,
  latestSnapshot,
  listSnapshots,
  payloadNames,
  pluginRoot,
  pruneSnapshots,
  restoreSnapshot,
  snapshotsRoot,
  withSnapshot,
} from "../lib/snapshot.js";

/** 造一个「插件根」：有 package.json（files 清单）+ 几个要备份的目录。 */
function makePluginRoot(root, version = "1.0.0") {
  writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "dsh-purge", version, files: ["lib", "client.js", "!lib/secret.md"] }, null, 2)}\n`,
  );
  writeFile(path.join(root, "lib", "index.js"), "export const a = 1;\n");
  writeFile(path.join(root, "lib", "secret.md"), "不要被快照带上\n");
  writeFile(path.join(root, "client.js"), "// client v1\n");
  return root;
}

test("payloadNames 以 package.json 的 files 为准，过滤 negation、补上 package.json", () => {
  const root = makeTmpRoot("dsh-purge-snap");
  try {
    makePluginRoot(root);
    const names = payloadNames(root);
    assert.ok(names.includes("lib"), "应该包含 lib");
    assert.ok(names.includes("client.js"), "应该包含 client.js");
    assert.ok(!names.includes("!lib/secret.md"), "negation 条目要过滤掉");
    assert.ok(names.includes("package.json"), "package.json 必须补上（回滚要还原版本号）");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("package.json 读不到时用兜底清单，照样能拍快照", () => {
  const root = makeTmpRoot("dsh-purge-snap-nopkg");
  try {
    writeFile(path.join(root, "lib", "index.js"), "export const a = 1;\n");
    const names = payloadNames(root);
    assert.ok(names.includes("lib"));
    assert.ok(names.includes("package.json"));
    const snap = createSnapshot({ reason: "test-nopkg", root });
    assert.equal(snap.ok, true, `快照应该成功：${snap.error || ""}`);
    assert.ok(snap.skipped.includes("bin"), "不存在的目录记进 skipped 而不是报错");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("createSnapshot 复制出完整内容并写 manifest", () => {
  const root = makeTmpRoot("dsh-purge-snap-create");
  try {
    makePluginRoot(root, "2.3.4");
    const snap = createSnapshot({ reason: "unit", root });
    assert.equal(snap.ok, true, `快照应该成功：${snap.error || ""}`);
    assert.ok(fs.existsSync(path.join(snap.dir, "lib", "index.js")));
    assert.ok(fs.existsSync(path.join(snap.dir, "client.js")));
    const manifest = JSON.parse(fs.readFileSync(path.join(snap.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, "2.3.4");
    assert.equal(manifest.reason, "unit");
    assert.ok(manifest.bytes > 0);
    assert.ok(manifest.files >= 3);
    assert.equal(snap.root, root, "返回值要带 root，回滚时才知道搬回哪");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("快照落在 DSH_HOME/dsh-purge/snapshots 下，不在插件目录里", () => {
  const root = makeTmpRoot("dsh-purge-snap-loc");
  try {
    makePluginRoot(root);
    const snap = createSnapshot({ reason: "loc", root });
    assert.equal(snap.ok, true);
    const base = snapshotsRoot();
    assert.ok(base.startsWith(sandboxHome()), "快照根必须在测试沙箱的 DSH_HOME 下");
    assert.ok(snap.dir.startsWith(base), "快照目录必须在快照根下");
    assert.ok(!snap.dir.startsWith(root), "快照不能落进插件目录，否则 overlay 会把它一起删掉");
    assert.ok(!fs.existsSync(path.join(root, "snapshots")), "插件目录里不该出现 snapshots");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("listSnapshots 新的在前，latestSnapshot 取最新", () => {
  const root = makeTmpRoot("dsh-purge-snap-list");
  try {
    makePluginRoot(root);
    const a = createSnapshot({ reason: "first", root });
    const b = createSnapshot({ reason: "second", root });
    assert.equal(a.ok && b.ok, true);
    const rows = listSnapshots();
    assert.ok(rows.length >= 2);
    assert.equal(rows[0].stamp, b.stamp, "最新的排在最前");
    assert.equal(latestSnapshot().stamp, b.stamp);
    assert.notEqual(a.stamp, b.stamp, "同一毫秒内两次快照也不能撞名");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("restoreSnapshot 把改坏的文件原样搬回去", () => {
  const root = makeTmpRoot("dsh-purge-snap-restore");
  try {
    makePluginRoot(root, "1.0.0");
    const snap = createSnapshot({ reason: "before-upgrade", root });
    assert.equal(snap.ok, true);

    // 模拟 overlay 的半成品：lib 被清空重写、版本号变了、多出一个新文件。
    fs.rmSync(path.join(root, "lib"), { recursive: true, force: true });
    writeFile(path.join(root, "lib", "half.js"), "upgrade 到一半\n");
    writeFile(path.join(root, "package.json"), '{"name":"dsh-purge","version":"9.9.9"}\n');

    const back = restoreSnapshot(snap.stamp, { root });
    assert.equal(back.ok, true, `回滚应该成功：${JSON.stringify(back.errors)}`);
    assert.equal(
      fs.readFileSync(path.join(root, "lib", "index.js"), "utf8"),
      "export const a = 1;\n",
      "lib/index.js 要还原",
    );
    assert.ok(!fs.existsSync(path.join(root, "lib", "half.js")), "升级期新增的文件不能残留成孤儿");
    assert.match(fs.readFileSync(path.join(root, "package.json"), "utf8"), /"version": "1\.0\.0"/);
    assert.equal(back.version, "1.0.0");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("restoreSnapshot 找不存在的快照时给人话错误，不动文件", () => {
  const root = makeTmpRoot("dsh-purge-snap-missing");
  try {
    makePluginRoot(root);
    const before = fs.readFileSync(path.join(root, "lib", "index.js"), "utf8");
    const back = restoreSnapshot("19990101-000000-000", { root });
    assert.equal(back.ok, false);
    assert.match(back.error, /找不到快照/);
    assert.equal(fs.readFileSync(path.join(root, "lib", "index.js"), "utf8"), before);
  } finally {
    cleanupTmpRoot(root);
  }
});

test("pruneSnapshots 只留最近 keep 份", () => {
  const root = makeTmpRoot("dsh-purge-snap-prune");
  try {
    makePluginRoot(root);
    for (let i = 0; i < DEFAULT_KEEP + 2; i += 1) {
      assert.equal(createSnapshot({ reason: `p${i}`, root }).ok, true);
    }
    const total = listSnapshots().length;
    assert.ok(total >= DEFAULT_KEEP + 2);
    const removed = pruneSnapshots(DEFAULT_KEEP);
    assert.equal(listSnapshots().length, DEFAULT_KEEP, "清完只剩 keep 份");
    assert.ok(removed.length >= 2, "删掉的多余快照要报出来");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("withSnapshot：fn 成功时保留快照、返回结果", async () => {
  const root = makeTmpRoot("dsh-purge-snap-ok");
  try {
    makePluginRoot(root);
    const { value, snapshot } = await withSnapshot("ok-path", async () => {
      writeFile(path.join(root, "lib", "index.js"), "升级后的内容\n");
      return "done";
    }, { root });
    assert.equal(value, "done");
    assert.equal(snapshot.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "lib", "index.js"), "utf8"), "升级后的内容\n");
    assert.equal(
      fs.readFileSync(path.join(snapshot.dir, "lib", "index.js"), "utf8"),
      "export const a = 1;\n",
      "快照里留的是升级前的内容",
    );
  } finally {
    cleanupTmpRoot(root);
  }
});

test("withSnapshot：fn 抛错就自动回滚，错误码 ROLLED_BACK 且带快照号", async () => {
  const root = makeTmpRoot("dsh-purge-snap-fail");
  try {
    makePluginRoot(root);
    let caught = null;
    try {
      await withSnapshot("fail-path", async () => {
        // 模拟 overlay 中途炸掉：lib 已经删了，新的还没拷进来。
        fs.rmSync(path.join(root, "lib"), { recursive: true, force: true });
        throw new Error("磁盘满了");
      }, { root });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "应该抛错");
    assert.match(caught.message, /磁盘满了/, "原始错误信息要保留");
    assert.equal(caught.code, "ROLLED_BACK");
    assert.match(caught.message, /已自动回滚到快照/);
    assert.ok(caught.snapshot, "错误里要带快照号，方便手工再说");
    assert.equal(
      fs.readFileSync(path.join(root, "lib", "index.js"), "utf8"),
      "export const a = 1;\n",
      "lib 必须被还原回来，插件还能启动",
    );
  } finally {
    cleanupTmpRoot(root);
  }
});

test("withSnapshot：快照建不出来时直接拒绝动手，抛 SNAPSHOT_FAILED", async () => {
  const root = makeTmpRoot("dsh-purge-snap-nosnap");
  try {
    makePluginRoot(root);
    // 把快照根指到一个「已经是文件」的路径上，mkdir 必然失败。
    const blocker = path.join(root, "blocked-dsh-home");
    writeFile(blocker, "我是文件不是目录\n");
    let caught = null;
    let ran = false;
    try {
      await withSnapshot("no-snapshot", async () => {
        ran = true;
      }, { root, dshHome: blocker });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "应该抛错");
    assert.equal(caught.code, "SNAPSHOT_FAILED");
    assert.match(caught.message, /已取消本次操作/);
    assert.equal(ran, false, "快照失败时绝不能执行会改文件的回调");
    assert.equal(fs.readFileSync(path.join(root, "lib", "index.js"), "utf8"), "export const a = 1;\n");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("pluginRoot() 指向插件根（有 package.json 的那层）", () => {
  const root = pluginRoot();
  assert.ok(fs.existsSync(path.join(root, "package.json")));
  assert.ok(fs.existsSync(path.join(root, "lib")));
});

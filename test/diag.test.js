import "./helpers.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanupTmpRoot, makeHost, makeTmpRoot, writeFile } from "./helpers.mjs";

const diag = await import("../lib/diag.js");

/** 造一个只有一条补丁会命中的宿主。 */
function fixture() {
  const root = makeTmpRoot("dsh-purge-diag");
  const host = makeHost(root, "ai");
  return { root, host };
}

test("asarVerdict 在没有 resourcesPath 的进程里不报假警报", () => {
  const saved = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", { value: "", configurable: true, writable: true });
  try {
    assert.equal(diag.asarVerdict(), "", "找不到归档时应返回空串，不该凭空说有补丁痕迹");
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: saved, configurable: true, writable: true });
  }
});

test("asarVerdict 遇到不存在的归档返回空串", () => {
  const saved = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
    value: path.join(makeTmpRoot("dsh-purge-asar-empty"), "nowhere"),
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(diag.asarVerdict(), "");
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: saved, configurable: true, writable: true });
  }
});

test("asarVerdict 对纯净归档说「没有任何补丁痕迹」，对含标记的归档说「有补丁痕迹」", () => {
  const root = makeTmpRoot("dsh-purge-asar");
  const saved = process.resourcesPath;
  try {
    const clean = path.join(root, "clean");
    fs.mkdirSync(clean, { recursive: true });
    writeFile(path.join(clean, "app.asar"), "这是一份没有任何补丁的归档，全是官方原始字节。\n");
    Object.defineProperty(process, "resourcesPath", { value: clean, configurable: true, writable: true });
    const a = diag.asarVerdict();
    assert.match(a, /没有任何补丁痕迹/, "纯净归档不该被报成需要处理");
    assert.match(a, /可以忽略/);

    const dirty = path.join(root, "dirty");
    fs.mkdirSync(dirty, { recursive: true });
    writeFile(path.join(dirty, "app.asar"), "……某处写着 [cfg] identity stripped ……\n");
    Object.defineProperty(process, "resourcesPath", { value: dirty, configurable: true, writable: true });
    const b = diag.asarVerdict();
    assert.match(b, /归档内有补丁痕迹/);
    assert.match(b, /\[cfg\]/, "要说清命中了什么");
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: saved, configurable: true, writable: true });
    cleanupTmpRoot(root);
  }
});

test("diagnose 在没有任何宿主时也不崩，给出空结论", async () => {
  const report = await diag.diagnose({ aiBase: "", dshHome: makeTmpRoot("dsh-purge-diag-none") });
  assert.equal(report.aiBase, "");
  assert.ok(report.summary);
  assert.equal(Array.isArray(report.problems), true);
  const text = diag.renderDiagnosis(report);
  assert.match(text, /dsh-purge 诊断/);
});

test("diagnose 能指出「缺目标文件」而不是含糊地说失败", async () => {
  const { root, host } = fixture();
  try {
    // 这个宿主只有 agent-instructions，其余 key 全都落空 → 那些补丁会报 missing_file。
    const report = await diag.diagnose({ aiBase: host, dshHome: root });
    const missing = report.problems.filter((p) => p.status === "missing_file");
    assert.ok(missing.length > 0, "应该有一批补丁因为宿主缺文件而报 missing_file");
    const one = missing[0];
    assert.match(one.reason, /缺目标文件|不存在/, `理由要具体：${one.reason}`);
    assert.ok(Array.isArray(one.evidence.files), "必须带证据");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("diagnose 对 needle 不命中给出「上游改过 / 整体替换」两类判断", async () => {
  const { root, host } = fixture();
  try {
    const report = await diag.diagnose({ aiBase: host, dshHome: root });
    const notFound = report.problems.filter((p) => p.status === "pattern_not_found" || p.status === "unmatched");
    if (!notFound.length) return; // 这个宿主恰好都命中时跳过（不硬造失败）
    const row = notFound[0];
    assert.match(row.reason, /needle/, `理由要点到 needle：${row.reason}`);
    const files = row.evidence.files.filter((f) => f.replacements);
    assert.ok(files.length > 0, "证据里要带每条 replacement 的命中情况");
    const r0 = files[0].replacements[0];
    assert.equal(typeof r0.hit, "boolean");
    assert.equal(typeof r0.firstLinePresent, "boolean", "要说清 needle 首行还在不在");
    assert.ok(r0.firstLine.length > 0, "要给出 needle 首行，方便对照源码");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("diagnose 的备份体检能分辨「与正式文件相同」和「不同」", async () => {
  const root = makeTmpRoot("dsh-purge-diag-bak");
  try {
    const host = makeHost(root, "ai");
    const fp = path.join(host, "dsh-agent-instructions", "lib", "index.js");
    // 造一份和正式文件不同的备份
    writeFile(`${fp}.dshpurge.bak`, "旧版本内容\n");
    const report = await diag.diagnose({ aiBase: host, dshHome: root });
    const baks = report.host.backups;
    assert.ok(baks.length >= 1, "要能发现 .dshpurge.bak");
    const row = baks.find((b) => b.path === `${fp}.dshpurge.bak`);
    assert.ok(row, "要报出这条备份");
    assert.equal(row.same, false, "内容不同要判 false");
    assert.ok(report.summary.backups >= 1);

    // 改成相同内容
    const same = fs.readFileSync(fp, "utf8");
    writeFile(`${fp}.dshpurge.bak`, same);
    const report2 = await diag.diagnose({ aiBase: host, dshHome: root });
    const row2 = report2.host.backups.find((b) => b.path === `${fp}.dshpurge.bak`);
    assert.equal(row2.same, true, "内容相同要判 true");
    assert.ok(report2.summary.backups_unchanged >= 1);
  } finally {
    cleanupTmpRoot(root);
  }
});

test("diagnose 报出快照列表（与 snapshot.js 对上）", async () => {
  const root = makeTmpRoot("dsh-purge-diag-snap");
  try {
    const host = makeHost(root, "ai");
    const snap = await import("../lib/snapshot.js");
    const made = snap.createSnapshot({ reason: "diag-test", root: host, dshHome: root });
    assert.equal(made.ok, true, made.error || "");
    const report = await diag.diagnose({ aiBase: host, dshHome: root });
    assert.ok(report.host.snapshots.length >= 1, "诊断里要能看到快照");
    assert.equal(report.host.snapshots[0].stamp, made.stamp);
    assert.match(diag.renderDiagnosis(report), /最近快照/);
  } finally {
    cleanupTmpRoot(root);
  }
});

test("diagnose 只读：跑完不改任何宿主文件", async () => {
  const root = makeTmpRoot("dsh-purge-diag-ro");
  try {
    const host = makeHost(root, "ai");
    const fp = path.join(host, "dsh-agent-instructions", "lib", "index.js");
    const before = fs.readFileSync(fp);
    const beforeStat = fs.statSync(fp);
    await diag.diagnose({ aiBase: host, dshHome: root });
    const after = fs.readFileSync(fp);
    assert.equal(after.equals(before), true, "内容不能变");
    assert.equal(fs.statSync(fp).mtimeMs, beforeStat.mtimeMs, "mtime 也不能变（说明真的没写）");
    assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), false, "诊断不该顺手建备份");
  } finally {
    cleanupTmpRoot(root);
  }
});

test("renderDiagnosis 在没有问题时给一句明确的「没问题」", async () => {
  const report = {
    at: new Date().toISOString(),
    aiBase: "/x",
    dshHome: "/y",
    summary: { patches_total: 1, applied: 1, pending: 0, groups: 1, backups: 0, backups_unchanged: 0, snapshots: 0 },
    host: { shims: { "dsh.cmd": { status: "original" } }, asar: {}, snapshots: [] },
    problems: [],
    display: [],
  };
  const text = diag.renderDiagnosis(report);
  assert.match(text, /没有发现需要处理的补丁/);
  assert.match(text, /dsh\.cmd=original/);
});

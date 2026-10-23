/**
 * 一键诊断：把「哪条补丁为什么没上」「备份到底有没有」讲清楚，
 * 不用再去逐条 grep 源码。
 *
 * 设计原则：
 * 1. 只读。这个模块绝不写任何宿主文件，也不改状态文件。
 * 2. 每条结论都要带证据（文件路径 + 偏移/行号 + 命中了什么），不能只说"失败"。
 * 3. 输出同时给人看（text）和给机器看（结构体），前端与 CLI 都能用。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALL_PATCHES,
  desktopAsarStillSealed,
  findAiBase,
  findDshHome,
  findDesktopShimDir,
  findShimDir,
  normalizeMarks,
  patchAppliesHere,
  patchApplied,
  patchStatus,
  shimFileStatus,
  targetFiles,
  groupPatchesForDisplay,
  tallyDisplayPatches,
} from "./core.js";
import { listSnapshots } from "./snapshot.js";

/** 判定「这个文件里到底有没有那条 needle」时用的最大读取量。宿主 JS 都在 1MB 以内。 */
const MAX_READ = 8 * 1024 * 1024;

/** 一条补丁的每个 replacement 逐条体检。 */
function inspectReplacements(text, patch) {
  const marks = normalizeMarks(text);
  const rows = [];
  const list = Array.isArray(patch.replacements) ? patch.replacements : [];
  for (let i = 0; i < list.length; i += 1) {
    const rep = list[i] || {};
    const raw = typeof rep.pattern === "string" ? rep.pattern : rep.pattern instanceof RegExp ? rep.pattern.source : "";
    const needle = normalizeMarks(String(raw).replace(/\r\n/g, "\n"));
    const textLf = marks;
    const hit = needle ? textLf.includes(needle) : false;
    rows.push({
      index: i,
      hit,
      // 没命中时给出「差在哪」的第一个特征：needle 首行在不在。首行在而整段不在，
      // 说明是中间被改过；首行都不在，说明这段代码整体被上游换掉了。
      firstLine: needle.split("\n")[0].slice(0, 80),
      firstLinePresent: needle ? textLf.includes(needle.split("\n")[0]) : false,
      needleBytes: Buffer.byteLength(needle, "utf8"),
    });
  }
  return rows;
}

function readTextSafe(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile()) return { ok: false, error: "不是文件" };
    if (st.size > MAX_READ) return { ok: false, error: `文件太大（${st.size} 字节）` };
    return { ok: true, text: fs.readFileSync(fp, "utf8"), size: st.size, mtime: st.mtime.toISOString() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 为什么这条补丁是这个状态。
 * @returns {{id:number,name:string,status:string,reason:string,evidence:object}}
 */
function explainPatch(patch, status, files) {
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  const evidence = { patch: patch.id, name: patch.name, keys, files: [] };
  const texts = [];
  for (const key of keys) {
    const raw = files[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!list.length) {
      evidence.files.push({ key, path: "", exists: false, note: "宿主里没有这个目标文件" });
      continue;
    }
    for (const fp of list) {
      const got = readTextSafe(fp);
      if (!got.ok) {
        evidence.files.push({ key, path: fp, exists: fs.existsSync(fp), note: got.error });
        continue;
      }
      const reps = inspectReplacements(got.text, patch);
      const applied = patchApplied(got.text, patch);
      evidence.files.push({
        key,
        path: fp,
        exists: true,
        size: got.size,
        mtime: got.mtime,
        applied,
        replacements: reps,
        // 备份是不是跟正式文件同一份（同一份说明这轮没改它）
        bak: fs.existsSync(`${fp}.dshpurge.bak`)
          ? { path: `${fp}.dshpurge.bak`, same: sameBytes(`${fp}.dshpurge.bak`, fp) }
          : null,
      });
      texts.push({ fp, text: got.text });
    }
  }

  let reason;
  if (!patchAppliesHere(patch)) {
    reason = "这条补丁不适用于当前宿主形态（surfaces 不匹配），是设计内的跳过。";
  } else if (status === "applied" || status === "already") {
    reason = "已应用：宿主文件里能找到补丁标记。";
  } else if (status === "skipped") {
    reason = patch.optional
      ? "optional 补丁，宿主里没用过它要撤掉的东西，跳过是幂等的正确表现。"
      : "目标文件里没有需要改的内容，跳过。";
  } else if (status === "missing_file") {
    const missing = evidence.files.filter((f) => !f.exists).map((f) => f.key);
    reason = missing.length
      ? `宿主里缺目标文件：${[...new Set(missing)].join(", ")}。这个 DSH 版本可能把它搬家了。`
      : "目标文件不存在。";
  } else if (status === "pattern_not_found" || status === "unmatched") {
    const miss = evidence.files.flatMap((f) => (f.replacements || []).filter((r) => !r.hit).map((r) => ({ key: f.key, ...r })));
    if (miss.length) {
      const first = miss[0];
      reason = first.firstLinePresent
        ? `needle 首行还在、整段对不上：宿主这段代码被上游改过（${first.key} 第 ${first.index + 1} 个 replacement）。`
        : `needle 首行都不在：宿主这段代码被上游整体替换了（${first.key} 第 ${first.index + 1} 个 replacement，首行「${first.firstLine}」）。`;
    } else {
      reason = "有 replacement 没命中，但找不到具体是哪个。";
    }
  } else if (status === "pending") {
    reason = "能匹配但写不进去：通常是文件权限、被进程占用，或写入校验反复失败。";
  } else if (status === "failed" || status === "read_error") {
    reason = "读或写目标文件时报错了，看 files 里的 note。";
  } else {
    reason = `状态 ${status}，未归类。`;
  }

  return { id: patch.id, name: patch.name, layer: patch.layer || "", status, reason, evidence };
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** 宿主侧的体检：路径、备份、shim、asar、快照。 */
function inspectHost(aiBase, dshHome) {
  const files = aiBase ? targetFiles(aiBase) : {};
  const out = { aiBase: aiBase || "", dshHome, files: {}, backups: [], shims: {}, asar: {}, snapshots: [] };

  for (const [key, raw] of Object.entries(files)) {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    out.files[key] = list.map((fp) => {
      let exists = false;
      let size = 0;
      try {
        const st = fs.statSync(fp);
        exists = st.isFile();
        size = st.size;
      } catch {
        /* 不存在 */
      }
      const bak = `${fp}.dshpurge.bak`;
      const hasBak = fs.existsSync(bak);
      if (hasBak) {
        out.backups.push({
          path: bak,
          target: fp,
          size: (() => {
            try {
              return fs.statSync(bak).size;
            } catch {
              return 0;
            }
          })(),
          same: sameBytes(bak, fp),
        });
      }
      return { path: fp, exists, size, hasBak };
    });
  }

  // shimFileStatus 收的是完整路径，不是名字。桌面安装只有 dsh.cmd 一份，
  // 所以另外两个报 missing 是正常的，不是错误。
  const shimDir = (() => {
    try {
      return findDesktopShimDir() || findShimDir() || "";
    } catch {
      return "";
    }
  })();
  out.shimDir = shimDir;
  for (const name of ["dsh.cmd", "dsh.ps1", "dsh"]) {
    const fp = shimDir ? path.join(shimDir, name) : "";
    let st = "missing";
    if (fp) {
      try {
        st = shimFileStatus(fp);
      } catch {
        st = "unknown";
      }
    }
    out.shims[name] = { path: fp, status: st };
  }

  let sealed = false;
  try {
    sealed = desktopAsarStillSealed();
  } catch {
    sealed = false;
  }
  out.asar = {
    still_sealed: sealed,
    // 「还在」不等于有问题：这个 build 可能实际加载的是解开的 resources/app。
    // 关键看归档里到底有没有补丁 —— 没有就是纯净原件，报"还在"是虚警。
    note: sealed ? asarVerdict() : "",
  };

  try {
    out.snapshots = listSnapshots(dshHome).slice(0, 5).map((s) => ({
      stamp: s.stamp,
      at: s.at,
      reason: s.reason,
      version: s.version,
      bytes: s.bytes,
      files: s.files,
    }));
  } catch {
    out.snapshots = [];
  }
  return out;
}

/**
 * 归档里有没有补丁痕迹。用流式扫描，不整文件读进内存（182MB 的 asar 读进来会炸）。
 * 返回一句结论，供 status 判断"还在"到底该不该报警。
 */
// 扫描 182MB 的归档不能每次 status 都干。按 (路径, 大小, mtime) 缓存结论。
const ASAR_VERDICT_CACHE = new Map();

export function asarVerdict() {
  const resources = (() => {
    try {
      return process.resourcesPath || "";
    } catch {
      return "";
    }
  })();
  if (!resources) return "";
  const c = path.join(path.normalize(resources), "app.asar");
  let key;
  try {
    const st = fs.statSync(c);
    if (!st.isFile()) return "";
    key = `${c}|${st.size}|${st.mtimeMs}`;
    if (ASAR_VERDICT_CACHE.has(key)) return ASAR_VERDICT_CACHE.get(key);
  } catch {
    return "";
  }
  let verdict;
  try {
    const hit = scanFileFor(c, ["dsh-purge", "[cfg] ", "dshPurgeHead"]);
    verdict = hit.length
      ? `归档内有补丁痕迹：${hit.join(", ")}。引擎级补丁要重启后才完整生效。`
      : "归档内没有任何补丁痕迹，是纯净原件；补丁在解开的 resources/app 里，这条警告可以忽略。";
  } catch {
    return "";
  }
  ASAR_VERDICT_CACHE.set(key, verdict);
  return verdict;
}

/** 分块读文件找几个 needle，命中就记下来（只记 first needle）。 */
function scanFileFor(fp, needles) {
  const chunk = 4 * 1024 * 1024;
  const overlap = 64;
  let fd;
  const hits = new Set();
  try {
    fd = fs.openSync(fp, "r");
    const buf = Buffer.allocUnsafe(chunk);
    let carry = Buffer.alloc(0);
    let read;
    while ((read = fs.readSync(fd, buf, 0, chunk, null)) > 0) {
      const piece = Buffer.concat([carry, buf.subarray(0, read)]);
      const text = piece.toString("latin1");
      for (const n of needles) {
        if (!hits.has(n) && text.includes(n)) hits.add(n);
      }
      if (hits.size === needles.length) break;
      carry = piece.subarray(Math.max(0, piece.length - overlap));
    }
  } catch {
    /* 读不了就不下结论 */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return [...hits];
}

/**
 * 完整诊断。
 * @returns {Promise<object>}
 */
export async function diagnose({ aiBase = findAiBase(), dshHome = findDshHome() } = {}) {
  const status = aiBase ? await patchStatus(aiBase) : {};
  const files = aiBase ? targetFiles(aiBase) : {};
  const host = inspectHost(aiBase, dshHome);

  const rows = [];
  let applied = 0;
  let already = 0;
  const problems = [];
  for (const patch of ALL_PATCHES) {
    const st = status[patch.id] || "missing_file";
    if (st === "na") continue;
    if (st === "applied") applied += 1;
    if (st === "already") already += 1;
    const bad = ["pending", "pattern_not_found", "unmatched", "failed", "read_error", "missing_file"].includes(st);
    if (!bad) continue;
    rows.push(explainPatch(patch, st, files));
  }

  for (const row of rows) problems.push(row);

  const display = groupPatchesForDisplay(ALL_PATCHES, status);
  const tally = tallyDisplayPatches(display);

  const backupCount = host.backups.length;
  const bakSame = host.backups.filter((b) => b.same).length;

  return {
    at: new Date().toISOString(),
    aiBase,
    dshHome,
    summary: {
      patches_total: ALL_PATCHES.length,
      applied: applied + already,
      pending: problems.length,
      groups: tally.total,
      backups: backupCount,
      backups_unchanged: bakSame,
      snapshots: host.snapshots.length,
    },
    host,
    problems,
    display,
  };
}

const LINE = (k, v, ok = null) => `${ok === null ? "  " : ok ? "✓ " : "✗ "}${String(k).padEnd(18)} ${v}`;

/** 把 diagnose() 结果渲染成人话。 */
export function renderDiagnosis(diag) {
  const out = [];
  out.push("dsh-purge 诊断 / Diagnosis");
  out.push(LINE("时间 / at", diag.at));
  out.push(LINE("插件根 / root", diag.aiBase || "未定位"));
  out.push(LINE("DSH_HOME", diag.dshHome || ""));
  out.push("");
  const s = diag.summary;
  out.push(
    `补丁 / patches: ${s.applied}/${s.patches_total} 已应用，${s.pending} 条有问题（分组 ${s.groups} 行）`,
  );
  out.push(`备份 / backups: ${s.backups} 个 .bak，其中 ${s.backups_unchanged} 个与正式文件相同（这轮没动）`);
  out.push(`更新快照 / snapshots: ${s.snapshots} 份`);
  out.push("");

  if (!diag.problems.length) {
    out.push("✓ 没有发现需要处理的补丁。");
  } else {
    out.push(`需要看的补丁（${diag.problems.length} 条）：`);
    for (const p of diag.problems) {
      out.push(`  ✗ [#${p.id}] ${p.name} — ${p.status}`);
      out.push(`      ${p.reason}`);
      for (const f of p.evidence.files) {
        if (!f.path) {
          out.push(`      · ${f.key}: （${f.note}）`);
          continue;
        }
        if (!f.exists) {
          out.push(`      · ${f.key}: 文件不存在 ${f.path}`);
          continue;
        }
        const miss = (f.replacements || []).filter((r) => !r.hit);
        out.push(
          `      · ${f.key}: ${f.path}` +
            (f.applied ? "（已应用）" : "") +
            (miss.length ? `，${miss.length}/${(f.replacements || []).length} 个 needle 未命中` : ""),
        );
        if (f.bak) out.push(`        备份 ${f.bak.same ? "与正式文件相同" : "与正式文件不同"}：${f.bak.path}`);
      }
    }
  }

  out.push("");
  out.push("shim: " + Object.entries(diag.host.shims).map(([k, v]) => `${k}=${v.status}`).join("  "));
  if (diag.host.asar.still_sealed) {
    out.push(`app.asar: 还在${diag.host.asar.note ? `。${diag.host.asar.note}` : ""}`);
  }
  if (diag.host.snapshots.length) {
    out.push("最近快照 / snapshots:");
    for (const snap of diag.host.snapshots) {
      out.push(`  · ${snap.stamp}  v${snap.version || "?"}  ${snap.reason || ""}  ${snap.files} 文件 / ${snap.bytes} 字节`);
    }
  }
  return out.join("\n");
}

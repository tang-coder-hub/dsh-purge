/**
 * 宿主文件快照 / 回滚。
 *
 * 为什么要和 snapshot.js 分开：snapshot.js 备份的是**插件自己**（更新前拍一份，更新炸了搬回来）。
 * 这里备份的是**被打补丁的宿主文件**（DSH 安装目录里的 @deepseek-ai 那些 index.js）。
 *
 * 已有的 `.dshpurge.bak` 解决不了「出问题一键回滚」这个问题：
 *  - 它是逐文件的，散在 62 个目录里，用户没法一眼看全；
 *  - `revertAll()` 还原后会把 bak unlink 掉，那一轮的历史就没了；
 *  - `refreshStaleBaksForUpgrade()` 会按需刷新 bak 内容，不同时刻的 bak 不是同一个时间点。
 * 所以这里在**每次写宿主之前**拍一份整包快照（2.5MB 量级，留 3 份 7.5MB），
 * 出问题 `purge_restore { scope: "host", stamp }` 一条命令搬回去。
 *
 * 本模块刻意不 import core.js：core.js 要 import 它，反过来引会成环。
 * 文件清单由调用方（core.js 的 applyPatchesAllHosts）算好传进来。
 */
import fs from "node:fs";
import path from "node:path";

/** 默认留几份宿主快照。一份约 2.5MB，3 份 ≈ 7.5MB。 */
export const DEFAULT_HOST_KEEP = 3;

const MANIFEST = "manifest.json";
const PAYLOAD = "files";

/** @returns {string} `<dshHome>/dsh-purge/host-snapshots` */
export function hostSnapshotsRoot(dshHome) {
  return path.join(dshHome, "dsh-purge", "host-snapshots");
}

function stampNow() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
    `${p(d.getMilliseconds(), 3)}`
  );
}

function dirSize(root) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let items = [];
      try {
        items = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const name of items) walk(path.join(p, name));
      return;
    }
    if (st.isFile()) {
      bytes += st.size;
      files += 1;
    }
  };
  walk(root);
  return { bytes, files };
}

/**
 * 把绝对路径转成快照里的存放位置。
 * aiBase 里的文件存成相对路径（换机器 / 换安装盘也能还原）；
 * aiBase 外的（比如 profile 下的 preset）存进 `outside/`，并把绝对路径记进清单。
 */
function splitPaths(aiBase, files) {
  const base = path.normalize(aiBase);
  const baseKey = base.replace(/\\/g, "/").toLowerCase();
  const inside = [];
  const outside = [];
  const seen = new Set();
  for (const raw of files || []) {
    if (!raw || typeof raw !== "string") continue;
    const abs = path.normalize(raw);
    const key = abs.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const lower = key;
    if (lower === baseKey || lower.startsWith(baseKey + "/")) {
      // 清单里用正斜杠：Windows 上 rel 是反斜杠，写进 manifest 后跨平台还原会踩坑。
      inside.push({ abs, rel: abs.slice(base.length + 1).replace(/\\/g, "/") });
    } else {
      outside.push({ abs });
    }
  }
  return { inside, outside };
}

/**
 * 拍一份宿主快照。
 * @param {object} opts
 * @param {string} opts.aiBase 宿主根（@deepseek-ai 那一层）
 * @param {string[]} opts.files 要备份的绝对路径（通常是 flattenTargetPaths(targetFiles(aiBase))）
 * @param {string} [opts.reason] 为什么拍（"apply" / "boot-reapply" / "revert" …）
 * @param {string} opts.dshHome DSH 主目录（快照存放根）
 * @returns {{ok:boolean, stamp?:string, dir?:string, aiBase?:string, files?:number, bytes?:number, missing?:string[], reason?:string, error?:string}}
 */
export function createHostSnapshot({ aiBase, files, reason = "", dshHome } = {}) {
  if (!aiBase) return { ok: false, error: "没有宿主根，无法拍快照" };
  if (!dshHome) return { ok: false, error: "没有 dsh 主目录，无法拍快照" };
  const { inside, outside } = splitPaths(aiBase, files);
  const root = hostSnapshotsRoot(dshHome);
  let dir;
  try {
    fs.mkdirSync(root, { recursive: true });
    const stamp = stampNow();
    dir = path.join(root, stamp);
    // 同一毫秒撞名时加后缀，绝不覆盖已有快照。
    let n = 1;
    while (fs.existsSync(dir)) {
      dir = path.join(root, `${stamp}-${n}`);
      n += 1;
    }
    fs.mkdirSync(path.join(dir, PAYLOAD), { recursive: true });
  } catch (e) {
    return { ok: false, error: `建快照目录失败：${e.message || e}` };
  }

  const savedInside = [];
  const savedOutside = [];
  const missing = [];
  try {
    for (const item of inside) {
      let st;
      try {
        st = fs.lstatSync(item.abs);
      } catch {
        missing.push(item.rel);
        continue;
      }
      if (!st.isFile()) continue;
      const to = path.join(dir, PAYLOAD, "inside", item.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(item.abs, to);
      savedInside.push(item.rel);
    }
    let idx = 0;
    for (const item of outside) {
      let st;
      try {
        st = fs.lstatSync(item.abs);
      } catch {
        missing.push(item.abs);
        continue;
      }
      if (!st.isFile()) continue;
      idx += 1;
      const slot = path.join(PAYLOAD, "outside", `${idx}__${path.basename(item.abs)}`);
      const to = path.join(dir, slot);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(item.abs, to);
      savedOutside.push({ abs: item.abs, slot: slot.replace(/\\/g, "/") });
    }
  } catch (e) {
    // 复制失败就把半份快照清掉：残缺快照回滚时会把宿主还原成缺文件的版本，比没有更糟。
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `快照复制失败：${e.message || e}` };
  }

  const size = dirSize(path.join(dir, PAYLOAD));
  const stamp = path.basename(dir);
  const manifest = {
    stamp,
    at: new Date().toISOString(),
    reason,
    aiBase,
    inside: savedInside,
    outside: savedOutside,
    missing,
    files: size.files,
    bytes: size.bytes,
  };
  try {
    fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (e) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `写快照清单失败：${e.message || e}` };
  }

  return {
    ok: true,
    stamp,
    dir,
    aiBase,
    reason,
    files: size.files,
    bytes: size.bytes,
    missing,
  };
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

/** 由新到旧列出宿主快照。读不出清单的半份目录跳过。 */
export function listHostSnapshots(dshHome) {
  const root = hostSnapshotsRoot(dshHome);
  let items = [];
  try {
    items = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const dir = path.join(root, it.name);
    const m = readManifest(dir);
    if (!m) continue;
    rows.push({ ...m, dir });
  }
  // stamp 为 YYYYMMDD-HHmmss-SSS，字典序即时间序；不用 Date 解析，避开时区坑。
  rows.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
  return rows;
}

export function latestHostSnapshot(dshHome) {
  return listHostSnapshots(dshHome)[0] || null;
}

/** 只留最新 keep 份，其余删掉。返回删掉的 stamp 列表。 */
export function pruneHostSnapshots(keep = DEFAULT_HOST_KEEP, dshHome) {
  const rows = listHostSnapshots(dshHome);
  const drop = rows.slice(Math.max(0, keep));
  const removed = [];
  for (const row of drop) {
    try {
      fs.rmSync(row.dir, { recursive: true, force: true });
      removed.push(row.stamp);
    } catch {
      // 删不掉就留着，下次再删 —— 不因为清理失败影响主流程。
    }
  }
  return removed;
}

/**
 * 把某份快照写回宿主。
 *
 * 只覆盖、不删除：补丁只会改已有文件的内容，不会新增文件，
 * 所以「覆盖 + 补回缺失」就足够，绝不能对 aiBase 做 rm（那是整个安装目录）。
 */
export function restoreHostSnapshot(stamp, { aiBase, dshHome } = {}) {
  const rows = listHostSnapshots(dshHome);
  const row = stamp ? rows.find((r) => r.stamp === stamp) : rows[0];
  if (!row) {
    return { ok: false, error: stamp ? `找不到宿主快照 ${stamp}` : "还没有任何宿主快照" };
  }
  const base = path.normalize(aiBase || row.aiBase || "");
  if (!base) return { ok: false, error: "不知道要还原到哪个宿主根" };

  const restored = [];
  const errors = [];
  for (const rel of row.inside || []) {
    const from = path.join(row.dir, PAYLOAD, "inside", rel);
    const to = path.join(base, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      restored.push(rel);
    } catch (e) {
      errors.push([rel, String(e && e.message ? e.message : e)]);
    }
  }
  for (const item of row.outside || []) {
    // slot 里已经带了 files/ 前缀（PAYLOAD 常量），别再拼一次。
    const from = path.join(row.dir, ...String(item.slot).split("/"));
    try {
      fs.mkdirSync(path.dirname(item.abs), { recursive: true });
      fs.copyFileSync(from, item.abs);
      restored.push(item.abs);
    } catch (e) {
      errors.push([item.abs, String(e && e.message ? e.message : e)]);
    }
  }
  return {
    ok: errors.length === 0,
    stamp: row.stamp,
    at: row.at,
    reason: row.reason,
    restored,
    errors,
  };
}

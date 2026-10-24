import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PATCHES, applyReplacementsToText } from '../lib/core.js';

const p57 = ALL_PATCHES.find((p) => p.id === 57);

// #57 的现实写法有好几种漂移。宿主真正用的是
// `compat?.supportsDeveloperRole !== false`（instructionRole 那行，带可选链 + 显式取反），
// 1.3.8 的变体表里只有 `compat.supportsDeveloperRole`（无 ?. 无 !==）和 `!== false` 的 role 版，
// 于是这一行永远匹配不上：文件里别的变体已经打过了（hasAnyMark 认为「打过」→ already），
// 但 instructionRole 那行其实没动 —— 状态在 applied / already / notFound 之间打转，
// 显示出来就是「能匹配却写不进去」。
test('#57 能命中 instructionRole + compat?.…!== false 这种写法', () => {
  const src =
    'const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";\n';
  const r = applyReplacementsToText(src, p57, '/tmp/openai-responses-shared.js');
  assert.equal(r.changed, true, '应当命中并改写');
  assert.match(r.text, /\[cfg\] developer role allowlist/, '应当打上标记注释');
  assert.ok(
    r.text.includes('api.openai.com') && r.text.includes('azure.com'),
    '应当补上 openai/azure 白名单判断',
  );
});

test('#57 对已经打过的内容是幂等的（第二次不再改动）', () => {
  const src =
    'const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";\n';
  const once = applyReplacementsToText(src, p57, '/tmp/openai-responses-shared.js');
  const twice = applyReplacementsToText(once.text, p57, '/tmp/openai-responses-shared.js');
  assert.equal(twice.changed, false, '第二次应当识别为已应用');
  assert.equal(twice.text, once.text, '字节不应有任何变化');
});

test('#57 的变体表覆盖三种现实写法（含可选链与显式取反）', () => {
  assert.ok(p57, '#57 应当存在');
  const joined = p57.replacements.map((x) => x.pattern).join('\n');
  assert.ok(joined.includes('compat.supportsDeveloperRole ?'), '缺无 ?. 的旧写法');
  assert.ok(joined.includes('compat?.supportsDeveloperRole !== false ?'), '缺 instructionRole 带取反的写法');
  assert.ok(
    joined.includes('useDeveloperRole') || joined.includes('!== false'),
    '缺 useDeveloperRole / role 分支的变体',
  );
});

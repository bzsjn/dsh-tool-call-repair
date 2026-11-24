// 把 .build/pNN.js 按编号合并成 lib/index.js。
// 分片是唯一手工维护的源；lib/index.js 由本脚本生成，不手改。
//
//   node scripts/build-index.mjs          写入 lib/index.js
//   node scripts/build-index.mjs --check  只比对，不一致则退出码 1
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.build');
const target = join(root, 'lib', 'index.js');

const parts = (await readdir(buildDir))
  .filter((name) => /^p\d{2}\.js$/.test(name))
  .sort();

if (parts.length === 0) {
  console.error('没有找到 .build/pNN.js 分片');
  process.exit(1);
}

const chunks = [];
for (const name of parts) chunks.push(await readFile(join(buildDir, name), 'utf8'));
const bundled = chunks.join('');

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current === bundled) {
    console.log(`ok  lib/index.js 与 ${parts.length} 个分片一致`);
    process.exit(0);
  }
  console.error(`lib/index.js 与分片不一致（分片 ${bundled.length} 字节，产物 ${current.length} 字节）`);
  process.exit(1);
}

await writeFile(target, bundled, 'utf8');
console.log(`写入 lib/index.js：${parts.length} 个分片，${bundled.length} 字节`);

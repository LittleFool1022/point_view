import { mkdir, writeFile } from 'node:fs/promises';
import { reviewFixturePcd } from '../src/domain/reviewFixtures';
// 界面验收用的合成点云（不含真实样本数据）：浏览器用例导入它，走“生成候选 → 未闭合清单处置”的真实路径。
const dir = 'artifacts/wall-review';
await mkdir(dir, { recursive: true });
const file = `${dir}/review-room-gap.pcd`;
await writeFile(file, reviewFixturePcd());
console.log(file);

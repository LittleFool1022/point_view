import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {openingRoomPcd} from '../tests/fixtures/openings';
// OPENING_FIXTURE_OUTPUT 指定完整目标文件路径，不表示输出目录。
const output=process.env.OPENING_FIXTURE_OUTPUT??'artifacts/openings-20261023/synthetic-openings.pcd';
await mkdir(dirname(output),{recursive:true});
await writeFile(output,openingRoomPcd());

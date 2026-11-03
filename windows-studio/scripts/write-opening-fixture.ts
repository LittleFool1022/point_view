import {writeFile} from 'node:fs/promises';
import {openingRoomPcd} from '../tests/fixtures/openings';
await writeFile('artifacts/openings-20261023/synthetic-openings.pcd',openingRoomPcd());

import {expect,it} from 'vitest';
import type {PointCloudData} from '../../src/domain/types';
import {pickCloudPoint, tryPickPreviewPoint} from '../src/domain/measurement';

it('测距使用完整源点坐标与原件点号，隐藏点不参与拾取',()=>{
  const cloud:PointCloudData={id:'measure',frameId:'source',stampNs:0n,positions:Float32Array.from([0,0,0,3,4,0,0,.05,1]),colors:new Uint8Array(9),visible:new Uint8Array([1,1,1])};
  const a=pickCloudPoint(cloud,{origin:[0,0,-1],direction:[0,0,1],toleranceM:.1});
  const b=pickCloudPoint(cloud,{origin:[3,4,-1],direction:[0,0,1],toleranceM:.1});
  expect(a).toMatchObject({index:0,position:[0,0,0]});expect(b).toMatchObject({index:1,position:[3,4,0]});
  expect(Math.hypot(...a.position.map((value,index)=>b.position[index]!-value))).toBe(5);
  cloud.visible[0]=0;cloud.visible[1]=0;
  expect(pickCloudPoint(cloud,{origin:[0,0,-1],direction:[0,0,1],toleranceM:.1}).index).toBe(2);
  cloud.visible.fill(0);expect(()=>pickCloudPoint(cloud,{origin:[0,0,-1],direction:[0,0,1],toleranceM:.1})).toThrow('未命中可见点云');
});

it('测距优先命中视线前方表面，不被背面更靠近射线的点抢占',()=>{
  // index 0: 前方表面 (z=0, 距射线 0.03m)
  // index 1: 后方墙面 (z=4, 距射线 0.00m)
  // index 2: 同一前方表面附近更靠近射线中心 (z=0.02, 距射线 0.005m)
  const positions = Float32Array.from([
    0.03, 0, 0,
    0, 0, 4,
    0.005, 0, 0.02,
  ]);
  const cloud: PointCloudData = {
    id: 'front-first',
    frameId: 'source',
    stampNs: 0n,
    positions,
    colors: new Uint8Array(9),
    visible: new Uint8Array([1, 1, 1]),
  };
  const front = pickCloudPoint(cloud, { origin: [0, 0, -1], direction: [0, 0, 1], toleranceM: 0.1 });
  expect(front.index).toBe(2);
  expect(front.position[2]).toBeCloseTo(0.02, 5);

  // 隐藏前景表面后，才允许命中后方点
  cloud.visible[0] = 0;
  cloud.visible[2] = 0;
  const back = pickCloudPoint(cloud, { origin: [0, 0, -1], direction: [0, 0, 1], toleranceM: 0.1 });
  expect(back.index).toBe(1);
});

it('悬停预览吸附映射原件点号，未命中时返回 undefined',()=>{
  const positions = Float32Array.from([0.02, 0, 0, 0, 0, 5]);
  const sourceIndices = Uint32Array.from([101, 202]);
  const visible = new Uint8Array(300).fill(1);
  const hit = tryPickPreviewPoint(positions, sourceIndices, visible, { origin: [0, 0, -1], direction: [0, 0, 1], toleranceM: 0.1 });
  expect(hit?.index).toBe(101);
  expect(tryPickPreviewPoint(positions, sourceIndices, visible, { origin: [5, 5, -1], direction: [0, 0, 1], toleranceM: 0.1 })).toBeUndefined();
});

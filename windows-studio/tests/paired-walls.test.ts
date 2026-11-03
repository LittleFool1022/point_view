import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { pairedWallsFromCloud } from "../src/pipeline/pairedWalls";

describe("未分析原图的桌面墙带",()=>{
  it("墙轴来自完整跨高度点，墙高取宿主支持分布，独立高点不拉高所有墙",async()=>{
    const points:number[]=[];
    for(let x=0;x<=4;x+=.03)for(let z=0;z<=2.8;z+=.05)points.push(x,0,z,x,3,z);
    for(let y=0;y<=3;y+=.03)for(let z=0;z<=2.8;z+=.05)points.push(0,y,z,4,y,z);
    points.push(2,1.5,100);
    const cloud={positions:Float32Array.from(points),visible:new Uint8Array(points.length/3).fill(1)} as PointCloudData;
    const walls=await pairedWallsFromCloud(cloud);
    expect(walls).toHaveLength(4);
    for(const wall of walls){expect(wall.bottomM).toBeGreaterThanOrEqual(0);expect(wall.bottomM).toBeLessThan(.15);expect(wall.topM).toBeGreaterThan(2.6);expect(wall.topM).toBeLessThan(3.1);}
  });
  it("几何缺失时拒绝补造墙带",async()=>{
    const cloud={positions:new Float32Array([0,0,0,1,1,.02]),visible:new Uint8Array([1,1])} as PointCloudData;
    await expect(pairedWallsFromCloud(cloud)).rejects.toThrow("证据不足");
  });
});

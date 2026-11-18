import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {unzipSync,strFromU8} from 'fflate';
import {cadSheet,createCadSheet} from '../../src/cad/sheet';
import {PAPER_SIZE_MM,type CadPaperSize} from '../../src/cad/model';
import {exportCadDxf} from '../../src/cad/dxf';
import {generateDrawing,decodeSource} from '../src/pipeline/analysis';
import {demoRoom} from '../src/domain/demo';
import {createSurveyDelivery} from '../src/domain/delivery';
it('五种图幅及比例有一致的毫米图框和DXF打印窗口；图纸超框或占据标题栏时禁止静默缩小',async()=>{
 const cloud=await decodeSource('测绘样本.pcd',demoRoom(),'m');mkdirSync('artifacts/cad-sheet-20261029',{recursive:true});
 for(const paperSize of Object.keys(PAPER_SIZE_MM) as CadPaperSize[])for(const scale of ['1:50','1:100','1:200']){
  const model=generateDrawing(cloud,'测绘样本.pcd','xy',{paperSize,scale}),s=cadSheet(model),denominator=Number(scale.split(':')[1]);
  if(paperSize==='A4'&&scale==='1:50'){expect(s.titleOverlapEntityIds.length).toBeGreaterThan(0);expect(()=>createCadSheet(model)).toThrow('标题栏重叠');writeFileSync(`artifacts/cad-sheet-20261029/${paperSize}-${denominator}.dxf`,exportCadDxf(model));continue;}
  const vector=createCadSheet(model);
  expect([s.widthMm,s.heightMm]).toEqual(PAPER_SIZE_MM[paperSize]);expect(s.denominator).toBe(denominator);
  expect(s.windowMm.max[0]-s.windowMm.min[0]).toBeCloseTo(s.widthMm*denominator,6);expect(s.outsideEntityIds).toEqual([]);
  expect(vector.svg).toContain(`width="${s.widthMm}mm"`);expect(vector.html).toContain(`size:${s.widthMm}mm ${s.heightMm}mm;margin:0`);
  expect(vector.svg).not.toContain('<canvas');
  writeFileSync(`artifacts/cad-sheet-20261029/${paperSize}-${denominator}.dxf`,exportCadDxf(model));
  if(paperSize==='A4'&&scale==='1:100'){writeFileSync('artifacts/cad-sheet-20261029/sheet.html',vector.html);writeFileSync('artifacts/cad-sheet-20261029/sheet.json',JSON.stringify(s));}
 }
 const tooBig=generateDrawing(cloud,'超框.pcd','xy',{paperSize:'A4',scale:'1:100'});tooBig.entities.push({id:'out',type:'line',start:[100000,0],end:[101000,0],layer:'OBSERVED_WALL',category:'wall',source:'manual',confidence:'mixed'});
 expect(cadSheet(tooBig).outsideEntityIds).toContain('out');expect(()=>createCadSheet(tooBig)).toThrow('超出图框');
 const titleOnly=structuredClone(tooBig);titleOnly.entities=titleOnly.entities.filter(e=>e.id!=='out');const title=titleOnly.entities.find(e=>e.layer==='TITLE_BLOCK'&&e.type==='polyline')!;if(title.type!=='polyline')throw Error('missing title');const x=(title.points[0]![0]+title.points[2]![0])/2,y=(title.points[0]![1]+title.points[2]![1])/2;
 titleOnly.entities.push({id:'title-collision',type:'line',start:[x-10,y],end:[x+10,y],layer:'OBSERVED_WALL',category:'wall',source:'manual',confidence:'mixed'});expect(cadSheet(titleOnly).titleOverlapEntityIds).toContain('title-collision');expect(()=>createCadSheet(titleOnly)).toThrow('标题栏重叠');
 const mismatch=structuredClone(tooBig);mismatch.scale='1:50';expect(()=>cadSheet(mismatch)).toThrow('不一致');
});
it('CAD包包含等比例矢量图和打印清单；原件哈希与每个新增文件可独立核对',async()=>{
 const bytes=demoRoom(),cloud=await decodeSource('图纸 & <样本>.pcd',bytes,'m'),model=generateDrawing(cloud,'图纸 & <样本>.pcd','xy',{scale:'1:100',paperSize:'A4'});
 const result=await createSurveyDelivery(model,{name:'样本.pcd',bytes,units:'m',synthetic:true});const zip=unzipSync(result.archive);
 expect(strFromU8(zip['survey-drawing/sheet.svg']!)).toContain('&amp; &lt;样本&gt;');
 const manifest=JSON.parse(strFromU8(zip['survey-drawing/survey-drawing.manifest.json']!));expect(manifest.plot.paperLayoutScale).toBe('1:1');expect(manifest.plot.pdfIncluded).toBe(false);
 for(const entry of manifest.files){const data=zip['survey-drawing/'+entry.name]!;expect(data.length).toBe(entry.size);const actual=Buffer.from(await crypto.subtle.digest('SHA-256',data.slice().buffer as ArrayBuffer)).toString('hex');expect(actual).toBe(entry.sha256);}
});
it('改图幅和比例保留几何、人工尺寸及坐标，仅更新纸面文字和取整；平立面轴向不冒充测量北向',async()=>{
 const {restyleCadDrawing}=await import('../../src/cad/sheet');const {appendDimension}=await import('../../src/cad/dimensions');
 const cloud=await decodeSource('现状测绘.pcd',demoRoom(),'m'),model=generateDrawing(cloud,'现状测绘.pcd','xy',{paperSize:'A3',scale:'1:100'});
 appendDimension(model,{id:'manual',kind:'horizontal',start:[0,0],end:[8000,0],linePoint:[0,-1000],textHeightMm:250,roundingMm:1,source:'manual'});
 const originalGeometry=model.entities.filter(e=>e.category==='wall');
 const next=restyleCadDrawing(model,{paperSize:'A2',scale:'1:50',roundingMm:.1});
 expect(next.entities.filter(e=>e.category==='wall')).toEqual(originalGeometry);
 expect(next.dimensions!.find(d=>d.id==='manual')).toMatchObject({start:[0,0],end:[8000,0],linePoint:[0,-1000],textHeightMm:125,roundingMm:.1});
 expect(model.scale).toBe('1:100');expect(cadSheet(next).denominator).toBe(50);
 expect(next.entities.some(e=>e.type==='text'&&e.text.includes('比例 1:50')&&e.text.includes('A2'))).toBe(true);
 expect(createCadSheet(next).sheet.outsideEntityIds).toEqual([]);
 expect(model.northArrow.label).toBe('+Y');expect(model.entities.filter(e=>e.type==='text'&&e.layer==='AXIS').every(e=>e.type==='text'&&e.heightMm===250)).toBe(true);
 const elevation=generateDrawing(cloud,'现状测绘.pcd','xz',{orthogonalizeWalls:false});expect(elevation.titleBlock.drawingName).toContain('正立面');expect(elevation.northArrow.label).toBe('+Z');
});

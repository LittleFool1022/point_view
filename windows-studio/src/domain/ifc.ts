import { openingPieces, openingTemplate } from "./openingTemplates";
import { buildingQuantities, validateBuilding, wallLength, type BuildingModel, type KeyframeObservation, type Evidence } from "./building";
const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function guid(key:string){let n=0x6c62272e07bb014262b821756295c58dn;for(const b of new TextEncoder().encode(key))n=((n^BigInt(b))*0x1000000000000000000013bn)&((1n<<128n)-1n);let out='';for(let i=0;i<22;i++){out=alphabet[Number(n&63n)]+out;n>>=6n;}return `'${out}'`;}
const text=(s:string)=>"'"+[...s].map(c=>{if(c.charCodeAt(0)>126||c.charCodeAt(0)<32)return '\\X2\\'+Array.from({length:c.length},(_,i)=>c.charCodeAt(i).toString(16).padStart(4,'0').toUpperCase()).join('')+'\\X0\\';return c==="'"?"''":c==='\\'?'\\\\':c;}).join('')+"'";
const real=(n:number)=>{if(!Number.isFinite(n))throw Error('IFC坐标或尺寸无效。');const s=Number(n.toFixed(9)).toString();return /[.eE]/.test(s)?s:s+'.';};
/** IFC4 STEP交换文件；开洞使用正式voids/fills关系，不把门窗当贴面。 */
export function exportIfc(model:BuildingModel,purpose:'review'|'delivery'='review') {
  const issues=validateBuilding(model),errors=issues.filter(i=>purpose==='delivery'||i.code!=='UNREVIEWED');
  if(errors.length||!model.walls.length)throw Error(errors[0]?.message??'建筑模型没有墙体。');
  const lines:string[]=[]; const add=(name:string,args:string)=>{const ref='#'+(lines.length+1);lines.push(`${ref}=${name}(${args});`);return ref;};
  const list=(refs:string[])=>'('+refs.join(',')+')',point=(p:number[])=>add('IFCCARTESIANPOINT',list(p.map(real))),dir=(p:number[])=>add('IFCDIRECTION',list(p.map(real)));
  const z=dir([0,0,1]),x=dir([1,0,0]),origin=point([0,0,0]),axis=add('IFCAXIS2PLACEMENT3D',`${origin},${z},${x}`);
  const placement=(parent:string,p:number[],u=[1,0,0])=>add('IFCLOCALPLACEMENT',`${parent},${add('IFCAXIS2PLACEMENT3D',`${point(p)},${z},${dir(u)}`)}`);
  const context=add('IFCGEOMETRICREPRESENTATIONCONTEXT',`$,'Model',3,0.000001,${axis},$`);
  const units=add('IFCUNITASSIGNMENT',list([add('IFCSIUNIT','*,.LENGTHUNIT.,$,.METRE.'),add('IFCSIUNIT','*,.AREAUNIT.,$,.SQUARE_METRE.'),add('IFCSIUNIT','*,.VOLUMEUNIT.,$,.CUBIC_METRE.')]));
  const id=(key:string)=>guid(model.id+':'+key);
  const project=add('IFCPROJECT',`${id('project')},$,'Survey Studio',${text(purpose==='review'?'DRAFT - review model':'Reviewed building model')},$,$,$,(${context}),${units}`);
  const sitePlace=placement('$',[0,0,0]),site=add('IFCSITE',`${id('site')},$,'Site',$,$,${sitePlace},$,$,.ELEMENT.,$,$,$,$,$`);
  const buildingPlace=placement(sitePlace,[0,0,0]),building=add('IFCBUILDING',`${id('building')},$,${text(model.sourceName??'Building')},$,$,${buildingPlace},$,$,.ELEMENT.,$,$,$`);
  const aggregates=(key:string,parent:string,children:string[])=>{if(children.length)add('IFCRELAGGREGATES',`${id('aggregate-'+key)},$,$,$,${parent},${list(children)}`);};
  aggregates('project',project,[site]);aggregates('site',site,[building]);
  const storeys=new Map<string,{ref:string;place:string;contained:string[];spaces:string[]}>();
  for(const l of model.levels){const place=placement(buildingPlace,[0,0,l.elevationM]),ref=add('IFCBUILDINGSTOREY',`${id('level-'+l.id)},$,${text(l.name)},$,$,${place},$,$,.ELEMENT.,${real(l.elevationM)}`);storeys.set(l.id,{ref,place,contained:[],spaces:[]});}aggregates('building',building,[...storeys.values()].map(s=>s.ref));
  const shape=(profile:string,height:number)=>{const solid=add('IFCEXTRUDEDAREASOLID',`${profile},${axis},${z},${real(height)}`),rep=add('IFCSHAPEREPRESENTATION',`${context},'Body','SweptSolid',(${solid})`);return add('IFCPRODUCTDEFINITIONSHAPE',`$,$,(${rep})`);};
  const rectangle=(w:number,d:number)=>{const center=add('IFCAXIS2PLACEMENT2D',`${point([w/2,0])},$`);return add('IFCRECTANGLEPROFILEDEF',`.AREA.,$,${center},${real(w)},${real(d)}`);};
  function evidence(ref:string,key:string,e?:Evidence,observations?:KeyframeObservation[]){const data:Record<string,string|number|boolean>={ElementId:key,ModelRevision:model.revision,SourceName:model.sourceName??'',SourceSHA256:model.sourceSha256??'',Purpose:purpose,Assumptions:(model.assumptions??[]).join(' ')};if(e)Object.assign(data,{EvidenceKind:e.kind,SourceAssetId:e.sourceAssetId,EvidenceRevision:e.revision,Confirmed:e.confirmed});
    if(observations?.length)Object.assign(data,{KeyframeObservationCount:observations.length,KeyframeObservations:JSON.stringify(observations)});
    const props=Object.entries(data).map(([name,value])=>add('IFCPROPERTYSINGLEVALUE',`${text(name)},$,${typeof value==='number'?`IFCINTEGER(${value})`:typeof value==='boolean'?`IFCBOOLEAN(.${value?'T':'F'}.)`:`IFCTEXT(${text(value)})`},$`));const set=add('IFCPROPERTYSET',`${id('pset-'+key)},$,'Pset_SurveyEvidence',$,${list(props)}`);add('IFCRELDEFINESBYPROPERTIES',`${id('pset-rel-'+key)},$,$,$,(${ref}),${set}`);
  }
  function quantity(ref:string,key:string,values:[string,string,number][]) {const q=values.map(([type,name,value])=>add(type,`${text(name)},$,$,${real(value)},$`));const set=add('IFCELEMENTQUANTITY',`${id('q-'+key)},$,'SurveyQuantities',$,$,${list(q)}`);add('IFCRELDEFINESBYPROPERTIES',`${id('qrel-'+key)},$,$,$,(${ref}),${set}`);}
  evidence(project,'project');const quantities=buildingQuantities(model);
  for(const w of model.walls){const floor=storeys.get(w.levelId)!,length=wallLength(w),ux=(w.axisM[1][0]-w.axisM[0][0])/length,uy=(w.axisM[1][1]-w.axisM[0][1])/length;
    const place=placement(floor.place,[...w.axisM[0],0],[ux,uy,0]),body=shape(rectangle(length,w.thicknessM),w.heightM),ref=add('IFCWALL',`${id('wall-'+w.id)},$,${text(w.name??w.id)},$,$,${place},${body},${text(w.id)},.NOTDEFINED.`);floor.contained.push(ref);evidence(ref,w.id,w.evidence);
    const q=quantities.walls.find(q=>q.id===w.id)!;quantity(ref,w.id,[['IFCQUANTITYLENGTH','Length',length],['IFCQUANTITYAREA','NetSideArea',q.netAreaM2],['IFCQUANTITYVOLUME','NetVolume',q.netVolumeM3]]);
    for(const o of model.openings.filter(o=>o.wallId===w.id)){const opPlace=placement(place,[o.offsetM,0,o.sillM]),opening=add('IFCOPENINGELEMENT',`${id('opening-'+o.id)},$,${text('Opening '+(o.name??o.id))},$,$,${opPlace},${shape(rectangle(o.widthM,w.thicknessM+.02),o.heightM)},$,.OPENING.`);add('IFCRELVOIDSELEMENT',`${id('void-'+o.id)},$,$,$,${ref},${opening}`);
      const pieces=openingPieces(o,w.thicknessM),solids=pieces.map(p=>{const local=add('IFCAXIS2PLACEMENT3D',`${point([p.x-p.width/2,0,p.z-p.height/2])},${z},${x}`);return add('IFCEXTRUDEDAREASOLID',`${rectangle(p.width,p.depth)},${local},${z},${real(p.height)}`);});
      const rep=add('IFCSHAPEREPRESENTATION',`${context},'Body','SweptSolid',${list(solids)}`),fillPlace=placement(opPlace,[0,0,0]),fillShape=add('IFCPRODUCTDEFINITIONSHAPE',`$,$,(${rep})`),fill=add(o.kind==='door'?'IFCDOOR':'IFCWINDOW',`${id('element-'+o.id)},$,${text(o.name??o.id)},$,$,${fillPlace},${fillShape},${text(o.id)},${real(o.heightM)},${real(o.widthM)},.${o.kind==='door'?'DOOR':'WINDOW'}.,.NOTDEFINED.,$`);add('IFCRELFILLSELEMENT',`${id('fill-'+o.id)},$,$,$,${opening},${fill}`);floor.contained.push(fill);evidence(fill,o.id,o.evidence,o.keyframes);
      if(o.design){const props=[['Template',openingTemplate(o)!.name],['TemplateId',o.design.template]].map(([name,value])=>add('IFCPROPERTYSINGLEVALUE',`${text(name!)},$,IFCTEXT(${text(value!)}),$`));props.push(add('IFCPROPERTYSINGLEVALUE',`'FrameWidth',$,IFCLENGTHMEASURE(${real(o.design.frameWidthM)}),$`));const set=add('IFCPROPERTYSET',`${id('opening-design-'+o.id)},$,'Pset_SurveyOpeningDesign',$,${list(props)}`);add('IFCRELDEFINESBYPROPERTIES',`${id('opening-design-rel-'+o.id)},$,$,$,(${fill}),${set}`);}

    }
  }
  for(const r of model.rooms){const floor=storeys.get(r.levelId)!,pts=[...r.boundaryM,r.boundaryM[0]!],curve=add('IFCPOLYLINE',list(pts.map(p=>point(p)))),profile=add('IFCARBITRARYCLOSEDPROFILEDEF',`.AREA.,$,${curve}`),place=placement(floor.place,[0,0,0]),ref=add('IFCSPACE',`${id('space-'+r.id)},$,${text(r.name)},$,$,${place},${shape(profile,r.heightM)},$,.ELEMENT.,.SPACE.,$`);floor.spaces.push(ref);evidence(ref,r.id,r.evidence);const q=quantities.rooms.find(q=>q.id===r.id)!;quantity(ref,r.id,[['IFCQUANTITYAREA','NetFloorArea',q.areaM2],['IFCQUANTITYVOLUME','NetVolume',q.volumeM3]]);}
  for(const [key,floor]of storeys){if(floor.contained.length)add('IFCRELCONTAINEDINSPATIALSTRUCTURE',`${id('contain-'+key)},$,$,$,${list(floor.contained)},${floor.ref}`);aggregates('spaces-'+key,floor.ref,floor.spaces);}
  const content=`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Survey Studio building model'),'2;1');\nFILE_NAME('survey-building.ifc','${new Date().toISOString().slice(0,19)}',('Survey Studio'),('Guanyao'),'Survey Studio 0.6.0','Survey Studio','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  return new TextEncoder().encode(content);
}

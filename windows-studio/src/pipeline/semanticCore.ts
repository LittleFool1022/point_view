import type {PairedCandidate} from '../domain/pairedReview';
/** 与Pillow BILINEAR相同的缩小三角滤波，避免直接抽样造成纹理混叠。 */
export function resizeRgb(rgba:Uint8ClampedArray,width:number,height:number,target=512):Uint8Array {
 const weights=(source:number)=>Array.from({length:target},(_,i)=>{
  const scale=source/target,support=Math.max(1,scale),center=(i+.5)*scale,start=Math.max(0,Math.floor(center-support+.5)),end=Math.min(source,Math.ceil(center+support-.5));
  const taps=[];let sum=0;for(let j=start;j<end;j++){const w=Math.max(0,1-Math.abs((j+.5-center)/support));taps.push({index:j,weight:w});sum+=w;}
  return taps.map(t=>({...t,weight:t.weight/sum}));
 });
 const wx=weights(width),wy=weights(height),horizontal=new Uint8Array(target*height*3),rgb=new Uint8Array(target*target*3);
 for(let y=0;y<height;y++)for(let x=0;x<target;x++)for(let c=0;c<3;c++){
  let value=0;for(const t of wx[x]!)value+=rgba[(y*width+t.index)*4+c]!*t.weight;horizontal[(y*target+x)*3+c]=Math.round(value);
 }
 for(let y=0;y<target;y++)for(let x=0;x<target;x++)for(let c=0;c<3;c++){
  let value=0;for(const t of wy[y]!)value+=horizontal[(t.index*target+x)*3+c]!*t.weight;rgb[(y*target+x)*3+c]=Math.round(value);
 }
 return rgb;
}
export function normalizedPixels(rgb:Uint8Array,size=512):Float32Array {
 const data=new Float32Array(3*size*size),mean=[.485,.456,.406],std=[.229,.224,.225];
 for(let c=0;c<3;c++)for(let i=0;i<size*size;i++)data[c*size*size+i]=(rgb[i*3+c]!/255-mean[c]!)/std[c]!;
 return data;
}
export function semanticCandidates(logits:Float32Array,shape:readonly number[],labels:Record<string,string>,imageWidth:number,imageHeight:number,frameId:string){
 const [batch,classes,height,width]=shape as [number,number,number,number];if(batch!==1||height!==128||width!==128||classes!==150||logits.length!==classes*height*width)throw Error('本地识别模型输出尺寸不符。');
 const size=512,count=size*size,semantic=new Uint8Array(count),confidence=new Float32Array(count),scores=new Float32Array(classes);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const py=(y+.5)*height/size-.5,px=(x+.5)*width/size-.5,y0=Math.max(0,Math.floor(py)),y1=Math.min(height-1,Math.floor(py)+1),x0=Math.max(0,Math.floor(px)),x1=Math.min(width-1,Math.floor(px)+1),dy=Math.max(0,py-y0),dx=Math.max(0,px-x0);
  let best=-Infinity,label=0;
  for(let c=0;c<classes;c++){const offset=c*height*width;const a=logits[offset+y0*width+x0]!*(1-dx)+logits[offset+y0*width+x1]!*dx,b=logits[offset+y1*width+x0]!*(1-dx)+logits[offset+y1*width+x1]!*dx,value=a*(1-dy)+b*dy;scores[c]=value;if(value>best){best=value;label=c;}}
  let sum=0;for(let c=0;c<classes;c++)sum+=Math.exp(scores[c]!-best);semantic[y*size+x]=label;confidence[y*size+x]=1/sum;
 }
 const candidates:PairedCandidate[]=[],instances=new Uint16Array(count),queue=new Int32Array(count);
 for(const [kind,name] of [['door','door'],['window','windowpane']] as const){
  const label=Number(Object.keys(labels).find(k=>labels[k]===name));if(!Number.isSafeInteger(label))throw Error('本地模型缺少门窗类别。');
  const visited=new Uint8Array(count);
  for(let pixel=0;pixel<count;pixel++){
   if(visited[pixel]||semantic[pixel]!==label)continue;
   let head=0,tail=1,minX=size,minY=size,maxX=0,maxY=0,sum=0;queue[0]=pixel;visited[pixel]=1;
   while(head<tail){const p=queue[head++]!,x=p%size,y=Math.floor(p/size);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);sum+=confidence[p]!;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||xx>=size||yy<0||yy>=size)continue;const next=yy*size+xx;if(!visited[next]&&semantic[next]===label){visited[next]=1;queue[tail++]=next;}}
   }
   if(tail<.003*count||sum/tail<.45)continue;
   candidates.push({id:`${frameId}-local-${candidates.length}`,label:kind,score:sum/tail,box:[minX/size*imageWidth,minY/size*imageHeight,(maxX+1)/size*imageWidth,(maxY+1)/size*imageHeight],wallSupportPoints:0,wallSupportFraction:0,decision:'pending',note:''});
   for(let i=0;i<tail;i++)instances[queue[i]!]=candidates.length;
  }
 }
 return {candidates,instances};
}
/** 重识别不丢弃人工意见；高重叠同类观察复用身份，其他旧观察保留。 */
export function mergeSemanticCandidates(previous:PairedCandidate[],next:PairedCandidate[]):PairedCandidate[]{
 const result=previous.map(a=>({...a})),used=new Set<string>();
 for(const candidate of next){let best=-1,bestIou=.5;
  for(let i=0;i<result.length;i++){const old=result[i]!;if(old.label!==candidate.label||used.has(old.id))continue;const a=old.box,b=candidate.box,intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection,iou=intersection/union;if(iou>bestIou){bestIou=iou;best=i;}}
  if(best>=0){const old=result[best]!;result[best]={...candidate,id:old.id,decision:old.decision,reviewedLabel:old.reviewedLabel,note:old.note};used.add(old.id);}
  else {let id=candidate.id;for(let n=1;result.some(a=>a.id===id);n++)id=`${candidate.id}-${n}`;result.push({...candidate,id});used.add(id);}
 }
 return result;
}

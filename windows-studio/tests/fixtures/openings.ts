/** 已知8×6×3m合成房间，闭合红门及有中框的双分格窗；仅作功能验证。 */
export function openingRoomPcd(){
 const points:Array<[number,number,number,number]>=[],white=(220<<16)|(220<<8)|220;
 for(let x=0;x<8;x+=.02)for(let z=0;z<3;z+=.02){const door=x>=1&&x<=2&&z<=2.1,window=x>=4&&x<=6&&z>=.9&&z<=2.2,frame=Math.abs(x-5)<.035;points.push([x,window&&!frame?-.06:0,z,door?(120<<16)|(35<<8)|30:window&&!frame?(90<<16)|(130<<8)|165:white],[x,6,z,white]);}
 for(let y=0;y<6;y+=.02)for(let z=0;z<3;z+=.02)points.push([0,y,z,white],[8,y,z,white]);
 const header=new TextEncoder().encode(`# SYNTHETIC OPENING TEST FIXTURE\nVERSION .7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\nPOINTS ${points.length}\nDATA binary\n`),bytes=new Uint8Array(header.length+points.length*16);bytes.set(header);const view=new DataView(bytes.buffer);
 points.forEach((p,i)=>{for(let k=0;k<3;k++)view.setFloat32(header.length+i*16+k*4,p[k]!,true);view.setUint32(header.length+i*16+12,p[3]!,true);});return bytes;
}

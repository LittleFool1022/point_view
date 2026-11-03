import type { IfcAPI } from "web-ifc";
/** 解析与几何检查是内置交付门槛，不替代完整IFC EXPRESS/目标软件认证。 */
export function checkIfc(api:IfcAPI,bytes:Uint8Array) {
  const id=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:false});if(id<0)throw Error('IFC解析失败。');
  try{const schema=api.GetModelSchema(id);if(schema!=='IFC4')throw Error('IFC模型必须为IFC4。');let products=0,triangles=0;const meshes:number[]=[];
    api.StreamAllMeshes(id,mesh=>{let valid=false;for(let i=0;i<mesh.geometries.size();i++){const g=api.GetGeometry(id,mesh.geometries.get(i).geometryExpressID),indices=api.GetIndexArray(g.GetIndexData(),g.GetIndexDataSize());if(indices.length){triangles+=indices.length/3;valid=true;}g.delete();}if(valid){products++;meshes.push(mesh.expressID);}});
    if(!products||!triangles)throw Error('IFC没有可解析的实体几何。');return {schema,products,triangles,meshes};
  }finally{api.CloseModel(id);}
}

import bpy
import json
import struct
from pathlib import Path
import numpy as np
OUT=Path(__file__).resolve().parents[2]/'artifacts/object-studio-validation'
file=OUT/'real-bunny.glb'
data=file.read_bytes(); json_size=struct.unpack_from('<I',data,12)[0]; doc=json.loads(data[20:20+json_size]); meta=doc['nodes'][0]['extras']['pointView']; report=meta['reconstruction']
accessor=doc['accessors'][doc['meshes'][0]['primitives'][0]['attributes']['POSITION']]
expected=np.array(accessor['max'])-np.array(accessor['min'])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(file))
obj=next(o for o in bpy.context.scene.objects if o.type=='MESH')
bpy.context.view_layer.update()
world=np.array([obj.matrix_world@v.co for v in obj.data.vertices])
dimensions=np.ptp(world,axis=0)
assert np.allclose(dimensions,expected,atol=1e-6)
assert len(obj.data.polygons)==report['triangles']
assert len(obj.data.vertices)==report['vertices']
assert len(obj.data.color_attributes)==0
assert meta['source']['sampled'] is False
assert np.isfinite(world).all()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'real-bunny.blend'))
result={'status':'PASS','blender':bpy.app.version_string,'source':'Stanford Computer Graphics Laboratory raw bun000 scan','inputPoints':report['inputPoints'],'vertices':len(obj.data.vertices),'triangles':len(obj.data.polygons),'worldDimensions':dimensions.tolist(),'components':report['components'],'boundaryEdges':report['boundaryEdges'],'material':meta['material'],'note':'保留单视角扫描的开放边界与分离表面，未宣称完整模型。'}
(OUT/'blender-real-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print('BLENDER_REAL_SCAN_PASS',json.dumps(result,ensure_ascii=False))

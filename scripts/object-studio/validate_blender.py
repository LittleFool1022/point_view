"""在 Blender 内验证真实 UI 导出的 GLB；失败用 --python-exit-code 返回非零。"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parents[2] / 'artifacts/object-studio-validation'
expected = {'original': (0, .85), 'plaster': (0,.92), 'metal': (1,.24), 'ceramic': (0,.18)}
reports=[]
for filename in sorted(OUT.glob('studio-*.glb')):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(filename))
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    assert len(meshes)==1, f'{filename.name}: mesh count'
    obj=meshes[0]
    preset='ceramic' if filename.stem=='studio-mm' else filename.stem.removeprefix('studio-')
    factor=.001 if filename.stem=='studio-mm' else 1
    bpy.context.view_layer.update()
    world_vertices=[obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    dims=[max(v[i] for v in world_vertices)-min(v[i] for v in world_vertices) for i in range(3)]
    assert all(abs(a-b*factor)<.005*factor for a,b in zip(dims,[1.2,.8,1.6])), (filename.name,dims)
    assert obj.data.polygons and all(len(face.vertices)==3 for face in obj.data.polygons)
    assert all(math.isfinite(v) for vertex in obj.data.vertices for v in vertex.co)
    assert all(abs(vertex.normal.length-1)<.01 for vertex in obj.data.vertices)
    # 比较极值方向与非等轴尺度；导出旋转应在 Blender 中恢复 Z-up。
    assert abs(obj.matrix_world.translation.length)<1e-5
    mat=obj.data.materials[0]
    node=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    metal=node.inputs['Metallic'].default_value; rough=node.inputs['Roughness'].default_value
    assert abs(metal-expected[preset][0])<1e-5 and abs(rough-expected[preset][1])<1e-5
    color_layers=list(obj.data.color_attributes)
    if preset=='original':
        assert color_layers, '采集颜色丢失'
        color=list(color_layers[0].data[0].color)[:3]
        def linear(value):
            c=value/255
            return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
        assert all(abs(a-linear(b))<.005 for a,b in zip(color,[176,106,68])), color
    else:
        assert not color_layers, '纯色材质仍携带染色顶点色'
        color=list(node.inputs['Base Color'].default_value)[:3]
    report=dict(file=filename.name, blender=bpy.app.version_string, meshCount=len(meshes), vertices=len(obj.data.vertices), triangles=len(obj.data.polygons), worldDimensions=dims, localDimensions=list(obj.dimensions), metallic=metal, roughness=rough, color=color, vertexColorLayers=len(color_layers), status='PASS')
    reports.append(report)
    # 保存可直接复核的原生工程；仅验证产物，产品出口仍为 GLB。
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / (filename.stem+'.blend')))
    if preset=='metal' and factor==1:
        scene=bpy.context.scene
        scene.render.engine='CYCLES'; scene.cycles.samples=16
        scene.render.threads_mode='FIXED'; scene.render.threads=4
        scene.render.resolution_x=640; scene.render.resolution_y=640; scene.render.resolution_percentage=100
        world=bpy.data.worlds.new('Studio world'); world.use_nodes=True
        world.node_tree.nodes['Background'].inputs[0].default_value=(.15,.18,.19,1)
        world.node_tree.nodes['Background'].inputs[1].default_value=.5; scene.world=world
        for loc,power,size in [((2,-3,3),500,3),((-2,-1,1),400,2),((0,2,2),650,2)]:
            bpy.ops.object.light_add(type='AREA',location=loc)
            light=bpy.context.object; light.data.energy=power; light.data.shape='DISK'; light.data.size=size
            light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler()
        bpy.ops.object.camera_add(location=(2,-3,1.5))
        camera=bpy.context.object; camera.rotation_euler=(-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.lens=60; scene.camera=camera
        scene.render.filepath=str(OUT/'blender-metal-render.png'); bpy.ops.render.render(write_still=True)
(OUT/'blender-results.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2))
assert len(reports)>=4
print('BLENDER_IMPORT_CHECKS_PASS',len(reports))

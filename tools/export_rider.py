"""Export the Blender rider mesh and its game bone weights.

Run: blender --background assets/rider.blend --python tools/export_rider.py
The POINT attributes carry material, occlusion, UV and the two skin influences.
"""
import bpy, json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
obj=bpy.data.objects['Rider']; mesh=obj.data
mesh.calc_loop_triangles()
a=mesh.attributes
def vals(name): return [round(v.value,5) for v in a[name].data]
def vec(values): return [round(v,5) for v in values]
out={'positions':[], 'normals':[], 'uvs':[], 'aux':[], 'boneIdx':[], 'boneWt':[], 'indices':[]}
for v in mesh.vertices:
    p=v.co; n=v.normal
    out['positions'] += vec((p.x,p.z,p.y)); out['normals'] += vec((n.x,n.z,n.y))
    i=v.index
    out['uvs'] += [a['uv_u'].data[i].value,a['uv_v'].data[i].value]
    out['aux'] += [a['material_id'].data[i].value,a['occlusion'].data[i].value]
    out['boneIdx'] += [a['bone_0'].data[i].value,a['bone_1'].data[i].value,0,0]
    out['boneWt'] += [a['weight_0'].data[i].value,a['weight_1'].data[i].value,0,0]
for tri in mesh.loop_triangles:
    out['indices'] += [tri.vertices[2],tri.vertices[1],tri.vertices[0]]
for key in ('uvs','aux','boneIdx','boneWt'): out[key]=vec(out[key])
(root/'src'/'assets'/'rider.json').write_text(json.dumps(out,separators=(',',':'))+'\n')
print('Exported rider',len(mesh.vertices),'vertices',len(mesh.loop_triangles),'triangles')

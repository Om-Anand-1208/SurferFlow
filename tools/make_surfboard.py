"""Build SurferFlow's board in Blender and export its shader-ready geometry.

Run: blender --background --factory-startup --python tools/make_surfboard.py
Blender axes are X=width, Y=length, Z=up; the exporter converts to game axes.
"""
import bpy, math, json, os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
verts, faces, mats = [], [], []
def vertex(x, y, z):
    verts.append((x, y, z)); return len(verts)-1
def face(indices, mat=0):
    faces.append(indices); mats.append(mat)
# Closely spaced stations make a smooth, asymmetric shortboard outline.
rows=[]
for i in range(33):
    t=i/32
    length=-0.88+1.76*t
    width=0.228 * max(0.012, math.sin(math.pi*t)**0.64) * (0.90 + 0.20*t)
    rocker=0.028*(length/0.88)**2
    row=[]
    for j in range(16):
        a=2*math.pi*j/16
        x=width*math.cos(a)
        # The original deck height and underside are kept for foot placement.
        z=0.119 + rocker + 0.020*math.sin(a) + 0.004*(1-(x/max(width,0.001))**2)
        row.append(vertex(x,length,z))
    rows.append(row)
for i in range(32):
    for j in range(16):
        face((rows[i][j],rows[i+1][j],rows[i+1][(j+1)%16],rows[i][(j+1)%16]))
face(tuple(reversed(rows[0]))); face(tuple(rows[-1]))
# Three dimensional fins and a contrasting inset stringer.
for x in (-0.095,0,0.095):
    a=vertex(x-0.009,-0.58,0.100); b=vertex(x-0.009,-0.77,0.105); c=vertex(x-0.006,-0.70,-0.015)
    d=vertex(x+0.009,-0.58,0.100); e=vertex(x+0.009,-0.77,0.105); f=vertex(x+0.006,-0.70,-0.015)
    for quad in ((a,c,b),(d,e,f),(a,b,e,d),(b,c,f,e),(c,a,d,f)): face(quad,1)
stripe=[]
for i in range(31):
    y=-0.84+i*1.68/30; z=0.144+0.028*(y/0.88)**2
    stripe.append((vertex(-0.006,y,z),vertex(0.006,y,z)))
for i in range(30): face((stripe[i][0],stripe[i+1][0],stripe[i+1][1],stripe[i][1]),2)
mesh=bpy.data.meshes.new('Surfboard'); mesh.from_pydata(verts, [], faces); mesh.update()
obj=bpy.data.objects.new('Surfboard', mesh); bpy.context.collection.objects.link(obj)
for name,col in [('Coral',(0.78,0.17,0.055,1)),('Fins',(0.018,0.013,0.009,1)),('Stringer',(0.015,0.10,0.16,1))]:
    m=bpy.data.materials.new(name); m.diffuse_color=col; m.use_nodes=True
    next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED').inputs['Base Color'].default_value=col
    mesh.materials.append(m)
for p,mi in zip(mesh.polygons,mats): p.material_index=mi; p.use_smooth=(mi==0)
bpy.context.view_layer.objects.active=obj; obj.select_set(True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(root/'assets'/'surfboard.blend'))
# Per-face vertices preserve material boundaries and Blender's smoothed normals.
mesh.calc_loop_triangles()
out={'positions':[], 'normals':[], 'uvs':[], 'material':[], 'indices':[]}
for tri in mesh.loop_triangles:
    poly=mesh.polygons[tri.polygon_index]
    for li in tri.loops:
        loop=mesh.loops[li]; v=mesh.vertices[loop.vertex_index]; p=v.co
        n=v.normal if poly.use_smooth else poly.normal
        out['positions'] += [p.x,p.z,p.y]
        out['normals'] += [n.x,n.z,n.y]
        out['uvs'] += [p.y+0.88,p.x+0.23]
        out['material'].append([7,3,5][poly.material_index])
        out['indices'].append(len(out['indices']))
    # axis exchange reverses winding
    out['indices'][-3],out['indices'][-1]=out['indices'][-1],out['indices'][-3]
for key in ('positions', 'normals', 'uvs'):
    out[key] = [round(value, 5) for value in out[key]]
(root/'src'/'assets'/'surfboard.json').write_text(json.dumps(out,separators=(',',':'))+'\n')
print('Exported',len(out['indices'])//3,'triangles')

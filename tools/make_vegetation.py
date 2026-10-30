"""Author low-poly coastal vegetation in Blender; export game-ready meshes.
Run: blender --background --factory-startup --python tools/make_vegetation.py
"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector
root=Path(__file__).resolve().parents[1]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
materials={}
for name,col in [('bark',(0.13,0.075,0.032)),('leaf',(0.10,0.23,0.055)),('lightleaf',(0.16,0.29,0.075)),('pine',(0.065,0.19,0.065)),('grass',(0.17,0.30,0.065)),('seed',(0.52,0.39,0.14))]:
    mat=bpy.data.materials.new(name); mat.diffuse_color=(*col,1); materials[name]=mat

def finish(name,mat):
    ob=bpy.context.object; ob.name=name; ob.data.materials.append(materials[mat]); return ob

def cone(name,loc,r1,r2,depth,mat, sides=7):
    bpy.ops.mesh.primitive_cone_add(vertices=sides,radius1=r1,radius2=r2,depth=depth,location=loc)
    return finish(name,mat)
def blob(name,loc,scale,mat):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=loc)
    ob=finish(name,mat); ob.scale=scale; return ob

def blade(name,angle,h,w):
    dx,dy=math.cos(angle),math.sin(angle); sx,sy=-dy,dx
    vs=[(-sx*w*.4,-sy*w*.4,0),(sx*w*.4,sy*w*.4,0), (dx*.08-sx*w,dy*.08-sy*w,h*.55),(dx*.08+sx*w,dy*.08+sy*w,h*.55),(dx*.27,dy*.27,h)]
    me=bpy.data.meshes.new(name); me.from_pydata(vs,[],[(0,1,3,2),(2,3,4)]); me.update()
    ob=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(ob); ob.data.materials.append(materials['grass']); return ob

groups={}
groups['grass']=[blade('GrassBlade',i*2*math.pi/12,0.75+(i%5)*.09,.035+(i%3)*.008) for i in range(12)]
for i in range(3):
    x=(i-1)*.12; y=i*.07; h=1.2+i*.1
    groups['grass'].append(cone('Stem',(x,y,h/2),.008,.004,h,'grass',4))
    for j in range(3): groups['grass'].append(blob('Seed',(x+.025*j,y,h-j*.065),(.025,.015,.045),'seed'))
groups['scrub']=[cone('ScrubTrunk',(0,0,.35),.095,.05,.7,'bark')]
for i,(x,y,z,sx,sy,sz) in enumerate([(-.3,-.08,.5,.37,.32,.42),(.25,.12,.55,.4,.37,.48),(-.04,.02,.82,.39,.35,.44),(.03,.34,.43,.32,.33,.35)]):
    groups['scrub'].append(blob('ScrubFoliage',(x,y,z),(sx,sy,sz),'leaf' if i%2 else 'lightleaf'))
groups['oak']=[cone('OakTrunk',(0,0,1.65),.22,.09,3.3,'bark',8)]
for i,(x,y,z,sx,sy,sz) in enumerate([(-1,.1,3.2,1.45,1.25,.95),(.9,-.35,3.55,1.35,1.3,1.1),(.1,.3,4.1,1.6,1.45,1.05),(.4,1,2.9,1.15,1,.85)]):
    groups['oak'].append(blob('OakCrown',(x,y,z),(sx,sy,sz),'leaf' if i%2 else 'lightleaf'))
groups['pine']=[cone('PineTrunk',(0,0,2.4),.13,.035,4.8,'bark')]
for i,(z,height,radius,offset) in enumerate([(1.28,2.05,1.18,-.16),(2.14,1.77,.93,.13),(2.95,1.53,.71,-.11),(3.68,1.24,.47,.08)]):
    groups['pine'].append(cone('PineBough',(offset,0,z+height/2),radius,.05,height,'pine' if i%2 else 'leaf',8))
bpy.context.view_layer.update()
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(root/'assets'/'coastal_vegetation.blend'))
out={}
for name,objects in groups.items():
    result={'positions':[],'normals':[],'colors':[],'indices':[]}
    for obj in objects:
        mesh=obj.data; mesh.calc_loop_triangles(); mat=obj.matrix_world; normalmat=mat.to_3x3().inverted().transposed()
        col=list(mesh.materials[0].diffuse_color)
        for tri in mesh.loop_triangles:
            poly=mesh.polygons[tri.polygon_index]
            for li in tri.loops:
                loop=mesh.loops[li]; v=mesh.vertices[loop.vertex_index]; p=mat @ v.co
                n=(normalmat @ (v.normal if poly.use_smooth else poly.normal)).normalized()
                result['positions'] += [p.x,p.z,p.y]; result['normals'] += [n.x,n.z,n.y]; result['colors'] += col
                result['indices'].append(len(result['indices']))
            result['indices'][-3],result['indices'][-1]=result['indices'][-1],result['indices'][-3]
    for key in ('positions', 'normals', 'colors'):
        result[key] = [round(value, 5) for value in result[key]]
    out[name]=result
    print(name,len(result['indices'])//3,'triangles')
(root/'src'/'assets'/'vegetation.json').write_text(json.dumps(out,separators=(',',':'))+'\n')

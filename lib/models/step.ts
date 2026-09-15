import {BufferGeometry,Float32BufferAttribute,Color,Group,Mesh,MeshStandardMaterial,DoubleSide} from 'three';
export type StepMesh={name?:string;color?:number[];attributes:{position:{array:number[]};normal?:{array:number[]}};index:{array:number[]};brep_faces?:Array<{first:number;last:number;color?:number[]}>};
export function createStepAssembly(meshes:StepMesh[]){
 const group=new Group();
 for(const item of meshes){
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(item.attributes.position.array,3));geometry.setIndex(item.index.array);
  if(item.attributes.normal)geometry.setAttribute('normal',new Float32BufferAttribute(item.attributes.normal.array,3));else geometry.computeVertexNormals();
  const color=(rgb?:number[])=>rgb?new Color(rgb[0],rgb[1],rgb[2]):new Color('#b2b9b5');
  const base=color(item.color),colors=new Float32Array(item.attributes.position.array.length);
  for(let i=0;i<colors.length;i+=3){colors[i]=base.r;colors[i+1]=base.g;colors[i+2]=base.b;}
  for(const face of item.brep_faces??[])if(face.color){const c=color(face.color);for(let i=Math.max(0,face.first*3);i<Math.min((face.last+1)*3,item.index.array.length);i++){const v=item.index.array[i]*3;colors[v]=c.r;colors[v+1]=c.g;colors[v+2]=c.b;}}
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
  // A single vertex-colour material needs no draw groups; material arrays without groups render nothing.
  const material=new MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:.55,metalness:.15,side:DoubleSide});
  const mesh=new Mesh(geometry,material);mesh.name=item.name??'';group.add(mesh);
 }
 return group;
}

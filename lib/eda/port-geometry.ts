// KiCad hierarchical-label outline: one text height long, half-height each side.
// Coordinates point right at 0 degrees; attachment stays at (0, 0).
export function hierarchicalPort(shape: string | undefined, size: number, rotation: number) {
  const templates: Record<string, number[][]> = {
    input: [[0,0],[1,1],[2,1],[2,-1],[1,-1],[0,0]],
    output: [[2,0],[1,-1],[0,-1],[0,1],[1,1],[2,0]],
    bidirectional: [[0,0],[1,-1],[2,0],[1,1],[0,0]],
    tri_state: [[0,0],[1,-1],[2,0],[1,1],[0,0]],
    passive: [[0,-1],[2,-1],[2,1],[0,1],[0,-1]],
  };
  const angle = -rotation * Math.PI / 180;
  return (templates[shape ?? "passive"] ?? templates.passive).map(([x,y])=>({
    x:(x*Math.cos(angle)-y*Math.sin(angle))*size/2,
    y:(x*Math.sin(angle)+y*Math.cos(angle))*size/2,
  }));
}

export function globalPort(shape:string|undefined,size:number,rotation:number,textLength:number){
 const h=size*.7,w=Math.max(size*2,textLength*size*.65+size*1.8);
 const input=shape==='input'||shape==='bidirectional'||shape==='tri_state';
 const output=shape==='output'||shape==='bidirectional'||shape==='tri_state';
 const outline=[[0,0],[input?h:0,-h],[w-(output?h:0),-h],[w,0],[w-(output?h:0),h],[input?h:0,h],[0,0]];
 const r=-rotation*Math.PI/180;
 return {points:outline.map(([x,y])=>({x:x*Math.cos(r)-y*Math.sin(r),y:x*Math.sin(r)+y*Math.cos(r)})),textOffset:w/2};
}

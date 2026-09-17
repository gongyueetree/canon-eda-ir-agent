// Legacy symbol fields are stored relative to the untransformed symbol origin.
export function legacyFieldLayout(x:number,y:number,originX:number,originY:number,matrix:number[],vertical:boolean,justify:string){
 const dx=x-originX,dy=y-originY;
 const vx=vertical?matrix[1]:matrix[0],vy=vertical?matrix[3]:matrix[2];
 const rotated=Math.abs(vy)>Math.abs(vx);
 const flipped=rotated?vy>0:vx<0;
 const align=justify==='L'?'start':justify==='R'?'end':'middle';
 return {x:originX+matrix[0]*dx+matrix[1]*dy,y:originY+matrix[2]*dx+matrix[3]*dy,rotation:rotated?'90':'0',align:flipped&&align!=='middle'?(align==='start'?'end':'start'):align} as const;
}
export function legacyLabelRotation(kind:string,orientation:number){
 return (kind==='local'?[0,90,180,270]:[180,90,0,270])[orientation]??0;
}

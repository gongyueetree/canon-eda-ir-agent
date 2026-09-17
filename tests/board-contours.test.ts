import assert from "node:assert/strict";
import test from "node:test";
import { ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import { cleanBoardContours } from "../lib/models/board-contours";

test("AD duplicate closing segment is not a hole; real cutouts triangulate", () => {
  const clean = cleanBoardContours([
    [{x:0,y:0},{x:20,y:0},{x:20,y:10},{x:0,y:10},{x:0,y:0}],
    [{x:0,y:0},{x:0,y:0}],
    [{x:5,y:4},{x:6,y:4},{x:6,y:5},{x:5,y:5},{x:5,y:4}],
    [{x:2,y:2},{x:3,y:2},{x:4,y:2}],
  ]);
  assert.equal(clean.length, 2);
  const shape = new Shape(clean[0].map(p => new Vector2(p.x,p.y)));
  shape.holes.push(new Path(clean[1].map(p => new Vector2(p.x,p.y))));
  const mesh = new ExtrudeGeometry(shape, {depth:1.6,bevelEnabled:false});
  assert.ok(mesh.attributes.position.count > 0);
  assert.ok(Array.from(mesh.attributes.position.array).every(Number.isFinite));
  // Surface area excludes the 1 mm² hole: two faces of 199, sides 64*1.6.
  const positions=mesh.attributes.position;
  let area=0;
  for(let i=0;i<positions.count;i+=3){
    const a=[positions.getX(i),positions.getY(i),positions.getZ(i)];
    const b=[positions.getX(i+1)-a[0],positions.getY(i+1)-a[1],positions.getZ(i+1)-a[2]];
    const c=[positions.getX(i+2)-a[0],positions.getY(i+2)-a[1],positions.getZ(i+2)-a[2]];
    area+=Math.hypot(b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0])/2;
  }
  assert.ok(Math.abs(area-500.4)<.001);
  mesh.dispose();
});
test("invalid contours are explicit errors, never NaN geometry", () => {
  assert.throws(()=>cleanBoardContours([[{x:NaN,y:0}]]),/无效坐标/);
  assert.deepEqual(cleanBoardContours([[{x:1,y:2}]]),[]);
});

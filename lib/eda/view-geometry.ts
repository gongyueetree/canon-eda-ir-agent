export type XY = { x: number; y: number };
/** Circular arc through three points, including major arcs. Collinear input is a line. */
export function arcPoints(a: XY, m: XY, b: XY): XY[] {
  const d = 2 * (a.x*(m.y-b.y)+m.x*(b.y-a.y)+b.x*(a.y-m.y));
  if (Math.abs(d)<1e-10) return [a,b];
  const q=(p:XY)=>p.x*p.x+p.y*p.y;
  const c={x:(q(a)*(m.y-b.y)+q(m)*(b.y-a.y)+q(b)*(a.y-m.y))/d,y:(q(a)*(b.x-m.x)+q(m)*(a.x-b.x)+q(b)*(m.x-a.x))/d};
  const angle=(p:XY)=>Math.atan2(p.y-c.y,p.x-c.x), tau=Math.PI*2;
  const positive=(n:number)=>(n%tau+tau)%tau;
  const start=angle(a), end=positive(angle(b)-start), middle=positive(angle(m)-start);
  const sweep=middle<=end+1e-9?end:end-tau, radius=Math.hypot(a.x-c.x,a.y-c.y);
  const count=Math.max(8,Math.ceil(Math.abs(sweep)*24));
  return Array.from({length:count+1},(_,i)=>({x:c.x+radius*Math.cos(start+sweep*i/count),y:c.y+radius*Math.sin(start+sweep*i/count)}));
}

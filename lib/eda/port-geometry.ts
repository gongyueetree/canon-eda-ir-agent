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

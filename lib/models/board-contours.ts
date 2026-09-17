import type { XY } from "../eda/view-geometry";

/** Remove duplicate vertices and zero-area rings before passing holes to Earcut.
 * A repeated board closing vertex is not a physical cutout. Keep actual rings
 * at source precision; the looser endpoint-joining tolerance is not used here.
 */
export function cleanBoardContours(loops: XY[][]): XY[][] {
  const near = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-8;
  return loops.flatMap(loop => {
    if (loop.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("板框包含无效坐标，无法生成 3D 板体。");
    const points = loop.filter((p, i) => !i || !near(p, loop[i - 1]));
    if (points.length > 1 && near(points[0], points.at(-1)!)) points.pop();
    if (points.length < 3) return [];
    const origin = points[0];
    const area = points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length];
      return sum + (p.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (p.y - origin.y);
    }, 0);
    return Math.abs(area) > 1e-12 ? [points] : [];
  });
}

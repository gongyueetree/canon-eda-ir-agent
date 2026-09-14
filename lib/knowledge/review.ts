import type { HardwareBlock, MiningResult, ReviewEdit } from "./types";
export function applyReview(
  result: MiningResult,
  original: HardwareBlock,
  edit: ReviewEdit,
): HardwareBlock {
  const block = structuredClone(original);
  if (edit.name !== undefined) {
    if (!edit.name.trim() || edit.name.length > 160)
      throw new Error("INVALID_NAME");
    block.name = edit.name.trim();
  }
  for (const m of edit.members ?? []) {
    const target = block.members.find((x) => x.partId === m.partId);
    if (
      !target ||
      !["included", "boundary", "review"].includes(m.decision) ||
      typeof m.role !== "string" ||
      m.role.length > 80
    )
      throw new Error("INVALID_MEMBER");
    if (
      target.partId === block.anchorId &&
      (m.decision !== "included" || m.role !== "ANCHOR")
    )
      throw new Error("ANCHOR_REQUIRED");
    target.decision = m.decision;
    target.role = m.role;
  }
  const included = new Set(
    block.members.filter((m) => m.decision === "included").map((m) => m.partId),
  );
  const pins = new Map(result.graph.pins.map((p) => [p.id, p]));
  const anchorPins = new Set(
    result.graph.pins
      .filter(
        (p) =>
          p.partId === block.anchorId &&
          (block.pinGroup === "CORE" || p.role === block.pinGroup),
      )
      .map((p) => p.id),
  );
  block.ports = result.graph.nets
    .filter(
      (n) =>
        n.pinIds.some(
          (id) =>
            included.has(pins.get(id)!.partId) &&
            (pins.get(id)!.partId !== block.anchorId || anchorPins.has(id)),
        ) &&
        (n.boundary ||
          n.pinIds.some((id) => !included.has(pins.get(id)!.partId)) ||
          n.pinIds.length === 1),
    )
    .map((n) => ({
      netId: n.id,
      name: original.ports.find((p) => p.netId === n.id)?.name ?? n.name,
      role: original.ports.find((p) => p.netId === n.id)?.role ?? n.role,
      pinIds: n.pinIds.filter((id) => included.has(pins.get(id)!.partId)),
      reason: "根据审核后的成员边界重新计算",
    }));
  const roles = [
    "POWER",
    "GROUND",
    "CLOCK",
    "RESET",
    "BOOT",
    "ENABLE",
    "USB",
    "SPI",
    "I2C",
    "SWD",
    "UART",
    "FEEDBACK",
    "SWITCHING",
    "ANALOG",
    "UNKNOWN",
  ];
  for (const p of edit.ports ?? []) {
    const target = block.ports.find((x) => x.netId === p.netId);
    if (
      !target ||
      !p.name?.trim() ||
      p.name.length > 160 ||
      !roles.includes(p.role)
    )
      throw new Error("INVALID_PORT");
    target.name = p.name;
    target.role = p.role;
  }
  block.placement = block.placement.filter((p) => included.has(p.partId));
  return block;
}
export function assertApprovable(block: HardwareBlock, acknowledge: boolean) {
  if (block.members.some((m) => m.decision === "review"))
    throw new Error("请先处理所有待确认成员");
  if (block.confidence.connectivity <= 0 || !block.evidence.length)
    throw new Error("缺少连接证据，不能批准");
  if (!acknowledge) throw new Error("请确认已查看源证据与解析限制");
}

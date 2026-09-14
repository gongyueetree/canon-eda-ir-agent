import type { CanonicalIrBundle, PartIr } from "../eda/types";
import { sha256, stableId } from "../eda/util";
import type {
  EngineeringGraph,
  GraphPin,
  HardwareBlock,
  MiningResult,
  PinRole,
} from "./types";
export const MINER_VERSION = "canon-block-miner/1.0.0";
export function pinRole(name: string, electricalType?: string): PinRole {
  const s = name.toUpperCase().replace(/[^A-Z0-9_+-]/g, "");
  if (/^(A?GND|DGND|VSS|PGND|EPAD|GNDA)\d*$/.test(s)) return "GROUND";
  if (["power_in", "power_out"].includes(electricalType ?? "")) return "POWER";
  if (/^(VDD|AVDD|DVDD|VCC|VDDA|VDDD|VBAT)\d*$/.test(s)) return "POWER";
  if (/^(SWDIO|SWCLK|SWO)$/.test(s)) return "SWD";
  if (/USB|^D[+-]$/.test(s)) return "USB";
  if (/^(SCLK|SCK|MOSI|MISO|SDATA|FSYNC|N?CS\d*)$/.test(s)) return "SPI";
  if (/^(SDA|SCL)\d*$/.test(s)) return "I2C";
  if (/^(TXD?|RXD?)\d*$/.test(s)) return "UART";
  if (/CLK|MCLK|OSC|XTAL/.test(s)) return "CLOCK";
  if (/RESET|NRST|^RST/.test(s)) return "RESET";
  if (/BOOT/.test(s)) return "BOOT";
  if (/^(EN|ENABLE|SHDN|NSHUTDOWN)$/.test(s)) return "ENABLE";
  if (/^(FB|VSENSE|COMP)$/.test(s)) return "FEEDBACK";
  if (/^(SW|PH|LX)$/.test(s)) return "SWITCHING";
  // VOUT is deliberately not a power classifier: e.g. DDS analog output.
  if (/^(VOUT|IOUT|AIN|AOUT|IN[+-]|OUT|RSET)/.test(s)) return "ANALOG";
  return "UNKNOWN";
}
export function engineeringGraph(bundle: CanonicalIrBundle): EngineeringGraph {
  const logical = bundle.schematics.some((s) => s.pins.length > 0);
  const domain = logical ? "schematic_logical" : "pcb_physical";
  const pins: GraphPin[] = logical
    ? bundle.schematics.flatMap((s) =>
        s.pins.map((p) => ({
          id: p.id,
          partId: p.partId,
          number: p.number,
          name: p.name,
          role: pinRole(p.name, p.electricalType),
          netIds: [],
        })),
      )
    : bundle.pcbs.flatMap((pcb) =>
        pcb.pads.flatMap((p) => {
          const part = bundle.parts.find(
            (x) =>
              x.footprintInstanceId === p.footprintId ||
              bundle.crossDocumentLinks.some(
                (l) =>
                  l.type === "part_to_footprint" &&
                  l.sourceEntityId === x.id &&
                  l.targetEntityId === p.footprintId &&
                  ["explicit", "verified"].includes(l.status),
              ),
          );
          return part
            ? [
                {
                  id: p.id,
                  partId: part.id,
                  number: p.number,
                  name: "",
                  role: "UNKNOWN" as PinRole,
                  netIds: [],
                },
              ]
            : [];
        }),
      );
  const byId = new Map(pins.map((p) => [p.id, p]));
  const nets = bundle.nets
    .filter((n) => n.domain === domain)
    .map((n) => {
      const linked = [
        ...new Set(
          n.endpoints.flatMap((e) =>
            e.targetId && byId.has(e.targetId) ? [e.targetId] : [],
          ),
        ),
      ];
      const roles = linked
        .map((id) => byId.get(id)!.role)
        .filter((r) => r !== "UNKNOWN");
      const nameRole = pinRole(n.canonicalName);
      const role = roles.includes("GROUND")
        ? "GROUND"
        : roles.includes("POWER")
          ? "POWER"
          : (roles[0] ??
            (nameRole === "GROUND" || nameRole === "POWER"
              ? nameRole
              : "UNKNOWN"));
      const boundary =
        role === "GROUND" || role === "POWER" || linked.length > 12;
      linked.forEach((id) => byId.get(id)!.netIds.push(n.id));
      return {
        id: n.id,
        name: n.canonicalName,
        role,
        pinIds: linked,
        boundary,
        confidence:
          n.resolution.method === "unresolved" ||
          n.resolution.method === "unknown"
            ? 0
            : n.resolution.confidence,
      };
    });
  return {
    pins,
    nets,
    domain,
    warnings: logical
      ? []
      : ["仅使用 PCB 显式 Pad-Net；管脚功能和未放置器件可能缺失。"],
  };
}
function passive(p: PartIr) {
  return /^(R|C|L|D|Y|FB)\d/i.test(p.reference);
}
export async function mineKnowledge(
  bundle: CanonicalIrBundle,
): Promise<MiningResult> {
  const graph = engineeringGraph(bundle);
  const pinsByPart = new Map<string, GraphPin[]>();
  graph.pins.forEach((p) => {
    const list = pinsByPart.get(p.partId) ?? [];
    list.push(p);
    pinsByPart.set(p.partId, list);
  });
  const anchors = bundle.parts
    .filter(
      (p) =>
        /^U\d|^IC\d/i.test(p.reference) &&
        p.variantStatus !== "dnp" &&
        (pinsByPart.get(p.id)?.length ?? 0) >= 3,
    )
    .map((p) => ({
      partId: p.id,
      reference: p.reference,
      mpn: p.mpnRaw || p.value,
      reason: "IC 位号且至少 3 个已解析管脚；核心功能需审核",
    }));
  const anchorSet = new Set(anchors.map((a) => a.partId));
  const byPin = new Map(graph.pins.map((p) => [p.id, p]));
  const byNet = new Map(graph.nets.map((n) => [n.id, n]));
  const sourceHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        assets: bundle.inventory.map((a) => [a.relativePath, a.sha256]).sort(),
        parser: bundle.parser,
        parts: bundle.parts,
        nets: bundle.nets,
        schematics: bundle.schematics,
        pcbs: bundle.pcbs,
        diagnostics: bundle.diagnostics,
      }),
    ),
  );
  const blocks: HardwareBlock[] = [];
  for (const anchor of anchors) {
    const anchorPart = bundle.parts.find((p) => p.id === anchor.partId)!;
    const anchorPins = pinsByPart.get(anchor.partId) ?? [];
    const isMcu = /STM32|RP2040|RP2350|ESP32|ATMEGA|PIC\d|LPC\d|NRF5/i.test(
      anchor.mpn,
    );
    const groups: (PinRole | "CORE")[] = isMcu
      ? [
          ...new Set(
            anchorPins
              .map((p) => p.role)
              .filter((r) => !["UNKNOWN", "GROUND"].includes(r)),
          ),
        ]
      : ["CORE"];
    if (!groups.length) groups.push("CORE");
    for (const group of groups) {
      const seeds = anchorPins.filter(
        (p) => group === "CORE" || p.role === group,
      );
      const seedNets = new Set(seeds.flatMap((p) => p.netIds));
      const candidates = new Map<
        string,
        { depth: number; nets: Set<string> }
      >();
      // Rail nets are inspected once for local decoupling, never used as traversal paths.
      let frontier = new Set(seedNets);
      for (let depth = 0; depth < 3; depth++) {
        const next = new Set<string>();
        for (const id of frontier) {
          const n = byNet.get(id);
          if (!n || n.confidence === 0) continue;
          for (const pinId of n.pinIds) {
            const p = byPin.get(pinId)!;
            if (p.partId === anchor.partId) continue;
            const part = bundle.parts.find((v) => v.id === p.partId)!;
            if (!part) continue;
            const found = candidates.get(p.partId) ?? {
              depth,
              nets: new Set<string>(),
            };
            found.nets.add(id);
            candidates.set(p.partId, found);
            if (
              n.boundary ||
              anchorSet.has(p.partId) ||
              !passive(part) ||
              depth === 2
            )
              continue;
            for (const peer of pinsByPart.get(p.partId) ?? [])
              for (const netId of peer.netIds)
                if (!byNet.get(netId)?.boundary && !frontier.has(netId))
                  next.add(netId);
          }
        }
        frontier = next;
      }
      const anchorFp = bundle.pcbs
        .flatMap((p) => p.footprints)
        .find((f) => f.id === anchorPart.footprintInstanceId);
      const members: HardwareBlock["members"] = [
        {
          partId: anchor.partId,
          reference: anchor.reference,
          value: anchorPart.value,
          role: "ANCHOR",
          decision: "included",
          score: 1,
          reasons: ["核心 IC"],
        },
      ];
      for (const [partId, c] of candidates) {
        const p = bundle.parts.find((x) => x.id === partId)!;
        const relevant = [...c.nets].map((id) => byNet.get(id)!);
        const railOnly = relevant.every((n) => n.boundary);
        const sharedIc = relevant.some((n) =>
          n.pinIds.some(
            (id) =>
              anchorSet.has(byPin.get(id)!.partId) &&
              byPin.get(id)!.partId !== anchor.partId,
          ),
        );
        const fp = bundle.pcbs
          .flatMap((p) => p.footprints)
          .find((f) => f.id === p.footprintInstanceId);
        const sameSide = fp?.side === anchorFp?.side;
        const distance =
          fp?.position && anchorFp?.position
            ? Math.hypot(
                Number(fp.position.x) - Number(anchorFp.position.x),
                Number(fp.position.y) - Number(anchorFp.position.y),
              )
            : undefined;
        const terminal =
          anchorSet.has(partId) ||
          /^J\d|^P\d/i.test(p.reference) ||
          !passive(p);
        const decoupling =
          /^C\d/i.test(p.reference) &&
          railOnly &&
          distance !== undefined &&
          distance < 5 &&
          sameSide;
        const score = terminal
          ? 0.1
          : railOnly
            ? decoupling
              ? 0.6
              : 0.2
            : Math.min(
                0.95,
                0.8 -
                  c.depth * 0.12 -
                  (sharedIc ? 0.2 : 0) +
                  (distance !== undefined && distance < 10 ? 0.1 : 0),
              );
        const decision =
          score >= 0.75 ? "included" : score >= 0.45 ? "review" : "boundary";
        members.push({
          partId,
          reference: p.reference,
          value: p.value,
          role: decoupling
            ? "DECOUPLING_CANDIDATE"
            : terminal
              ? "EXTERNAL"
              : railOnly
                ? "SHARED_RAIL"
                : "PERIPHERAL",
          decision,
          score,
          reasons: [
            `扩展深度 ${c.depth + 1}`,
            railOnly ? "公共网络不继续扩展" : "经非公共网络关联",
            ...(sharedIc ? ["网络连接另一核心 IC"] : []),
            ...(distance !== undefined
              ? [`距核心 ${distance.toFixed(2)} mm`]
              : ["没有可用 PCB 距离证据"]),
          ],
        });
      }
      const included = new Set(
        members.filter((m) => m.decision === "included").map((m) => m.partId),
      );
      const selectedPins = new Set(seeds.map((p) => p.id));
      const ports = graph.nets
        .filter(
          (n) =>
            n.pinIds.some(
              (id) =>
                included.has(byPin.get(id)!.partId) &&
                (byPin.get(id)!.partId !== anchor.partId ||
                  selectedPins.has(id)),
            ) &&
            (n.boundary ||
              n.pinIds.some((id) => !included.has(byPin.get(id)!.partId)) ||
              n.pinIds.length === 1),
        )
        .map((n) => ({
          netId: n.id,
          name: n.name,
          role: n.role,
          pinIds: n.pinIds.filter((id) => included.has(byPin.get(id)!.partId)),
          reason: n.boundary ? "公共网络边界" : "功能块外部连接 / 单端网络",
        }));
      const evidence = members.flatMap((m) =>
        bundle.parts
          .find((p) => p.id === m.partId)!
          .sourceRefs.map((source) => ({
            id: stableId("evidence", m.partId, source.path, source.nativeId),
            entityId: m.partId,
            source,
            sha256: bundle.inventory.find((a) => a.id === source.assetId)
              ?.sha256,
            parserVersion: bundle.parser.adapterVersion,
            explanation: m.reasons.join("；"),
          })),
      );
      for (const n of graph.nets.filter((n) =>
        n.pinIds.some((id) => included.has(byPin.get(id)!.partId)),
      ))
        for (const source of bundle.nets.find((v) => v.id === n.id)!.sourceRefs)
          evidence.push({
            id: stableId("evidence", n.id, source.path, source.nativeId),
            entityId: n.id,
            source,
            sha256: bundle.inventory.find((a) => a.id === source.assetId)
              ?.sha256,
            parserVersion: bundle.parser.adapterVersion,
            explanation: "源 IR 网络端点关联",
          });
      const structuralGap = bundle.diagnostics.some((d) =>
        [
          "SCHEMATIC_MIRROR_UNRESOLVED",
          "SCHEMATIC_MULTIUNIT_UNRESOLVED",
          "SCHEMATIC_HIERARCHY_BUS_UNRESOLVED",
          "SYMBOL_DEFINITION_MISSING",
          "SCHEMATIC_CONNECTIVITY_CONFLICT",
        ].includes(d.code),
      );
      const relevantNets = graph.nets.filter((n) =>
        n.pinIds.some((id) => selectedPins.has(id)),
      );
      blocks.push({
        id: stableId("block", sourceHash, MINER_VERSION, anchor.partId, group),
        name: `${anchor.mpn} · ${group}`,
        anchorId: anchor.partId,
        anchorReference: anchor.reference,
        mpn: anchor.mpn,
        pinGroup: group,
        members,
        ports,
        evidence,
        confidence: {
          connectivity:
            !structuralGap && relevantNets.length
              ? Math.min(...relevantNets.map((n) => n.confidence))
              : 0,
          semantic: group === "CORE" ? 0.4 : 0.65,
          sourceQuality: bundle.fidelity.criticalGapCount ? 0.4 : 0.7,
        },
        warnings: [
          ...graph.warnings,
          ...(bundle.fidelity.criticalGapCount
            ? ["源 IR 存在解析缺口，发布前须明确确认"]
            : []),
          ...(members.some((m) => m.decision === "review")
            ? ["存在待确认成员"]
            : []),
          "未进行数据手册校验或仿真；不能据此认定电路正确",
        ],
        status: "CANDIDATE",
        placement: bundle.pcbs
          .flatMap((p) => p.footprints)
          .flatMap((f) => {
            const p = bundle.parts.find((p) => p.footprintInstanceId === f.id);
            return p && included.has(p.id) && f.position && anchorFp?.position
              ? [
                  {
                    partId: p.id,
                    dxMm: Number(f.position.x) - Number(anchorFp.position.x),
                    dyMm: Number(f.position.y) - Number(anchorFp.position.y),
                    rotation: Number(f.rotation),
                    side: f.side,
                  },
                ]
              : [];
          }),
      });
    }
  }
  return {
    schema: "canon.hardware-knowledge",
    schemaVersion: "1.0.0",
    minerVersion: MINER_VERSION,
    bundleId: bundle.bundleId,
    sourceHash,
    graph,
    anchors,
    blocks,
    warnings: [
      ...graph.warnings,
      ...(!anchors.length
        ? ["没有找到具备管脚证据的核心 IC；不会生成虚构功能块。"]
        : []),
    ],
  };
}

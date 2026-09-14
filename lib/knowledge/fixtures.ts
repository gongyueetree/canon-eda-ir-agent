/** Synthetic parser fixtures, not vendor reference designs or fabrication assets. */
export function miningFixture(name: "AD9837" | "TPS5430" | "STM32") {
  const pins =
    name === "AD9837"
      ? ["VDD", "GND", "MCLK", "SCLK", "SDATA", "FSYNC", "VOUT", "RSET"]
      : name === "TPS5430"
        ? ["VIN", "GND", "BOOT", "PH", "VSENSE", "EN"]
        : [
            "VDD",
            "GND",
            "OSC_IN",
            "NRST",
            "BOOT0",
            "SWDIO",
            "SWCLK",
            "USB_DP",
            "USB_DM",
          ];
  const lib = (id: string, names: string[]) =>
    `(symbol "${id}" ${names.map((p, i) => `(pin passive line (at 0 ${-i * 5} 0) (length 2.54) (name "${p}") (number "${i + 1}"))`).join(" ")})`;
  const symbol = (id: string, ref: string, val: string, x: number, y: number) =>
    `(symbol (lib_id "${id}") (at ${x} ${y} 0) (unit 1) (in_bom yes) (on_board yes) (uuid ${ref}) (property "Reference" "${ref}" (at ${x} ${y} 0)) (property "Value" "${val}" (at ${x} ${y} 0)))`;
  const labels = pins
    .map(
      (p, i) =>
        `(global_label "${p}" (shape input) (at 20 ${20 + i * 5} 0) (uuid label-${i}))`,
    )
    .join(" ");
  const net =
    name === "AD9837" ? "RSET" : name === "TPS5430" ? "VSENSE" : "NRST";
  return `(kicad_sch (version 20250114) (generator eeschema) (uuid ${name}) (paper "A4") (lib_symbols ${lib("Fixture:IC", pins)} ${lib("Device:R", ["~", "~"])} ${lib("Fixture:Other", ["VDD", "GND", "TX"])}) ${symbol("Fixture:IC", "U1", name, 20, 20)} ${labels} ${symbol("Device:R", "R1", "10k", 60, 20)} (global_label "${net}" (shape input) (at 60 20 0) (uuid r-top)) (global_label "GND" (shape input) (at 60 25 0) (uuid r-bottom)) ${symbol("Fixture:Other", "U2", "OTHER_IC", 100, 20)} (global_label "VDD" (shape input) (at 100 20 0) (uuid other-power)) (global_label "GND" (shape input) (at 100 25 0) (uuid other-ground)))`;
}
export function miningDemoFiles() {
  return [
    new File([miningFixture("AD9837")], "synthetic-ad9837.kicad_sch", {
      type: "text/plain",
    }),
  ];
}

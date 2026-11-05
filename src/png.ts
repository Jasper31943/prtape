import { Resvg } from "@resvg/resvg-js";

/** Rasterize the timeline SVG. System fonts supply Inter and JetBrains Mono when installed. */
export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1920 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Inter",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

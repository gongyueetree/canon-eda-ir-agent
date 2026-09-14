import type { InputAsset, SourceAsset } from "../eda/types";
import type { PdfEvidenceDocument } from "./types";
export async function extractPdfEvidence(
  input: InputAsset,
  asset: SourceAsset,
): Promise<PdfEvidenceDocument> {
  const base: PdfEvidenceDocument = {
    assetId: asset.id,
    path: input.path,
    sha256: asset.sha256,
    parserVersion: "pdfjs-text/1.0.0",
    status: "FAILED",
    pages: [],
    connectivityStatus: "NOT_RECONSTRUCTED",
  };
  if (input.bytes.length > 30 * 1024 * 1024)
    return { ...base, error: "PDF 超过 30 MB 限制" };
  if (new TextDecoder().decode(input.bytes.subarray(0, 5)) !== "%PDF-")
    return { ...base, error: "无效的 PDF 签名" };
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined")
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: input.bytes.slice(),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const timer = setTimeout(() => {
    void task.destroy();
  }, 60000);
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw new Error("PDF 超过 100 页限制，请分批处理");
    let total = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      total += content.items.length;
      if (total > 100000) throw new Error("PDF 文本对象超过 100000 上限");
      const text = content.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        const transform = pdfjs.Util.transform(
          viewport.transform,
          item.transform,
        );
        const height = Math.hypot(transform[2], transform[3]);
        return [
          {
            text: item.str,
            bbox: [transform[4], transform[5] - height, item.width, height] as [
              number,
              number,
              number,
              number,
            ],
          },
        ];
      });
      base.pages.push({
        page: i,
        width: viewport.width,
        height: viewport.height,
        text,
        referenceCandidates: [
          ...new Set(
            text.flatMap(
              (t) => t.text.match(/\b(?:U|IC|R|C|L|D|Q|J|Y)\d+\b/g) ?? [],
            ),
          ),
        ],
      });
      page.cleanup();
    }
    return {
      ...base,
      status: base.pages.some((p) => p.text.length)
        ? "TEXT_EXTRACTED"
        : "OCR_REQUIRED",
    };
  } catch (error) {
    return {
      ...base,
      pages: [],
      error: error instanceof Error ? error.message : "PDF 解析失败",
    };
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}

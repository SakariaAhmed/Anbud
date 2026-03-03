declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    version?: string;
  }

  function pdfParse(dataBuffer: Buffer | Uint8Array): Promise<PdfParseResult>;

  export default pdfParse;
}

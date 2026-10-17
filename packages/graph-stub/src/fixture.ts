/**
 * The single driveItem the QA Graph stub serves, and the PDF bytes the smoke
 * journey stages. Kept in one module so the stub's delta page and content
 * endpoint cannot describe different items.
 */
export const SMOKE_ITEM_ID = "smoke-item";
export const SMOKE_ITEM_NAME = "smoke.pdf";
/** Normalized to "notes" by the adapter's path normalizer. */
export const SMOKE_ITEM_PARENT_PATH = "/drive/root:/notes";
export const SMOKE_ITEM_ETAG = "smoke-etag-1";
export const SMOKE_PDF_MARKER = "petroglyph smoke";

const PDF_SOURCE = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (${SMOKE_PDF_MARKER}) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF
`;

export function smokePdfBytes(): Uint8Array {
  return new TextEncoder().encode(PDF_SOURCE);
}

/** The delta page item, shaped as Graph returns a file driveItem. */
export function smokeDriveItem(eTag: string = SMOKE_ITEM_ETAG): {
  id: string;
  name: string;
  eTag: string;
  parentReference: { path: string };
  file: { mimeType: string };
} {
  return {
    id: SMOKE_ITEM_ID,
    name: SMOKE_ITEM_NAME,
    eTag,
    parentReference: { path: SMOKE_ITEM_PARENT_PATH },
    file: { mimeType: "application/pdf" },
  };
}

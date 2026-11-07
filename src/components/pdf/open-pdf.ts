type PageSource = {
  getPage: (number: number) => Promise<{ getViewport: (options: { scale: number }) => { width: number; height: number } }>;
};

/**
 * The loaded document and its first page's height-to-width ratio, or null when
 * the document itself cannot be read. A first page that fails to load only
 * leaves the ratio unknown (null): the other pages may still draw, and the
 * page draws decide whether the PDF is handed off.
 */
export async function openPdf<Doc extends PageSource>(loading: Promise<Doc>): Promise<{ doc: Doc; ratio: number | null } | null> {
  let doc: Doc;
  try {
    doc = await loading;
  } catch {
    return null;
  }
  try {
    const { width, height } = (await doc.getPage(1)).getViewport({ scale: 1 });
    return { doc, ratio: height / width };
  } catch {
    return { doc, ratio: null };
  }
}

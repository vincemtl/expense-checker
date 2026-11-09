// Turns a PDF into positioned words and lines using pdf.js.
// pdfjsLib is injected so the same code runs in the browser and in Node tests.

const PRIVATE_USE = new RegExp('[' + String.fromCharCode(0xe000) + '-' + String.fromCharCode(0xf8ff) + ']', 'g'); // icon glyphs (checkboxes, comment bubbles, pencils)

export async function extractPages(pdfjsLib, data) {
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  try {
    return await readPages(pdfjsLib, task);
  } finally {
    // always close the document, also when it could not be read
    await task.destroy().catch(() => {});
  }
}

async function readPages(pdfjsLib, task) {
  const doc = await task.promise;
  const meta = await doc.getMetadata().catch(() => null);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const words = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const str = it.str.replace(PRIVATE_USE, ' ');
      if (!str.trim()) continue;
      const m = pdfjsLib.Util.transform(vp.transform, it.transform);
      const x = m[4];
      const y = m[5]; // baseline, measured from the top of the page
      const charW = str.length ? it.width / str.length : 0;
      const re = /\S+/g;
      let mt;
      while ((mt = re.exec(str))) {
        const x0 = x + mt.index * charW;
        const x1 = x0 + mt[0].length * charW;
        words.push({ t: mt[0], x0, x1, xc: (x0 + x1) / 2, y });
      }
    }
    pages.push({ number: i, width: vp.width, height: vp.height, words, lines: groupLines(words, i) });
    page.cleanup();
  }
  const title = meta && meta.info ? meta.info.Title || '' : '';
  return { title, pages };
}

export function groupLines(words, pageNumber, tol = 2.2) {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.y - last.y) <= tol) {
      last.words.push(w);
    } else {
      lines.push({ page: pageNumber, y: w.y, words: [w] });
    }
  }
  for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0);
  return lines;
}

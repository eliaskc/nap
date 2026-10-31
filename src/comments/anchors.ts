/**
 * Finds comment text in the framed page. A comment stores its quote and up to 32 characters on
 * each side, in a copy of the page text with whitespace collapsed. When the page changes, the
 * comment matches the occurrence with the most matching context.
 */

export const CONTEXT = 32;
export const MAX_QUOTE = 2000;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);

export type TextIndex = {
  doc: Document;
  text: string;
  nodes: Array<Text>;
  nodeOf: Array<number>;
  offsetOf: Array<number>;
};

export type Quote = { quote: string; prefix: string; suffix: string };

export function buildIndex(doc: Document): TextIndex {
  const index: TextIndex = { doc, text: "", nodes: [], nodeOf: [], offsetOf: [] };
  if (!doc.body) return index;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const chars: Array<string> = [];
  let space = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentNode && SKIP.has(node.parentNode.nodeName.toUpperCase())) continue;
    const value = node.nodeValue ?? "";
    const k = index.nodes.push(node) - 1;
    for (let i = 0; i < value.length; i++) {
      if (/\s/.test(value[i])) {
        if (space) continue;
        chars.push(" ");
        space = true;
      } else {
        chars.push(value[i]);
        space = false;
      }
      index.nodeOf.push(k);
      index.offsetOf.push(i);
    }
  }
  index.text = chars.join("");
  return index;
}

/** The first character at or after a boundary point. */
function indexAt(index: TextIndex, container: Node, offset: number) {
  const point = index.doc.createRange();
  point.setStart(container, offset);
  let low = 0;
  let high = index.text.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (point.comparePoint(index.nodes[index.nodeOf[mid]], index.offsetOf[mid]) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function rangeFor(index: TextIndex, start: number, end: number) {
  const range = index.doc.createRange();
  range.setStart(index.nodes[index.nodeOf[start]], index.offsetOf[start]);
  range.setEnd(index.nodes[index.nodeOf[end - 1]], index.offsetOf[end - 1] + 1);
  return range;
}

/** The quote for a selection, or null when it holds no text. */
export function quoteSelection(index: TextIndex, selection: Range) {
  let start = indexAt(index, selection.startContainer, selection.startOffset);
  let end = indexAt(index, selection.endContainer, selection.endOffset);
  while (start < end && index.text[start] === " ") start++;
  while (end > start && index.text[end - 1] === " ") end--;
  end = Math.min(end, start + MAX_QUOTE);
  if (end <= start) return null;
  return {
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: index.text.slice(end, end + CONTEXT),
    range: rangeFor(index, start, end),
  };
}

function common(a: string, b: string, fromEnd: boolean) {
  let n = 0;
  while (
    n < a.length &&
    n < b.length &&
    (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])
  )
    n++;
  return n;
}

/** Where a quote is now: the match with the most matching context around it. */
export function locate(index: TextIndex, { quote, prefix, suffix }: Quote) {
  if (!quote) return null;
  let best = -1;
  let bestScore = -1;
  let at = index.text.indexOf(quote);
  for (let tries = 0; at !== -1 && tries < 1000; tries++) {
    const before = index.text.slice(Math.max(0, at - prefix.length), at);
    const after = index.text.slice(at + quote.length, at + quote.length + suffix.length);
    const score = common(before, prefix, true) + common(after, suffix, false);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
    at = index.text.indexOf(quote, at + 1);
  }
  return best === -1 ? null : { range: rangeFor(index, best, best + quote.length), start: best };
}

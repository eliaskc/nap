/**
 * Messages between the Nap bar (app.tsx) and the comments script in the sandboxed artifact frame
 * (frame.ts). The frame is untrusted: the bar checks the sender and treats everything it gets as
 * data to show as text, never as HTML or as a request to the comment API.
 */

/** In the frame's viewport, in CSS pixels. */
export type Rect = { left: number; top: number; width: number; height: number };

export type FrameAnchor = {
  /** A thread id, or "__draft" for a comment being written. */
  id: string;
  /** Where the text starts in the page text. Orders threads. */
  start: number;
  rects: Array<Rect>;
  /** The right edge of the text's block, for pins in the margin. */
  blockRight: number | null;
};

export type FrameState = {
  type: "nap:comments:state";
  path: string;
  dark: boolean;
  /** The frame's width without its scroll bar. */
  width: number;
  anchors: Array<FrameAnchor>;
  selection: { quote: string; prefix: string; suffix: string; rects: Array<Rect> } | null;
};

export type FromFrame =
  | FrameState
  | { type: "nap:comments:ready"; path: string }
  | { type: "nap:comments:hover"; id: string | null }
  | { type: "nap:comments:click"; id: string | null }
  | { type: "nap:comments:shortcut" };

export type QuoteMessage = { id: string; quote: string; prefix: string; suffix: string };

export type FromBar =
  | {
      type: "nap:comments:threads";
      threads: Array<QuoteMessage>;
      active: string | null;
      draft: { quote: string; prefix: string; suffix: string } | null;
    }
  | { type: "nap:comments:clear-selection" }
  | { type: "nap:comments:scroll"; id: string };

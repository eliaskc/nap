/**
 * The Nap kit. Everything here is light; import heavier parts directly:
 *   import { BarChart, LineChart, Histogram } from '@/kit/charts'   // Recharts
 *   import { Code, Diff } from '@/kit/code'                          // WASM highlighter
 *   import { Dashboard, Panel, Metric, useDataset } from '@/kit/dashboard'  // dashboards
 * Read KIT.md for the overview and each file for the full props.
 */
export { KitRoot } from './root'
export { Page, Section, Title, Lede, Eyebrow, Prose, Wide } from './page'
export {
  Num,
  Stat,
  StatRow,
  Takeaway,
  Callout,
  MarginNote,
  Tag,
  Chip,
  Disclosure,
  DisclosureGroup,
  Reveal,
  Compare,
  Steps,
  KeyValue,
  Legend,
  Diamond,
  PlusIcon,
} from './content'
export type { CompareColumn, CompareRow, Step, KV, LegendItem } from './content'
export { Wired, DiagramFrame } from './wires'
export type { Wire, Side } from './wires'
export { Flow, Swimlane } from './flow'
export type { FlowNode, FlowEdge, FlowGroup, FlowLane, FlowDivider, FlowProps, SwimStep } from './flow'
export { Sequence } from './sequence'
export type { Participant, SequenceItem } from './sequence'
export { Tracks } from './tracks'
export type { Track, TrackItem } from './tracks'
export { Cycle } from './cycle'
export type { CycleStep } from './cycle'
export { Timeline } from './timeline'
export type { TimelineItem } from './timeline'
export { Matrix } from './matrix'
export type { MatrixState, MatrixCell } from './matrix'
export { Segmented, StageSwitcher, Picker } from './stateful'
export type { Stage, PickerOption, SegmentOption } from './stateful'
export { ScrollStory } from './story'
export type { Chapter } from './story'
export { Sparkline } from './sparkline'
export { Morph } from './morph'
export { Tree } from './tree'
export type { TreeNode } from './tree'
export { Figure, Lightbox, PhoneFrame } from './media'
export type { LightboxImage } from './media'
export { cn, ease, toneColor, toneMix, useWidth, useReducedMotion, type Tone } from './lib'

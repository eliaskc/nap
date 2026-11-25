/**
 * Kitchen sink: every kit component with realistic sample content, for checking the
 * kit visually. Not part of a normal build. `pnpm dev` → /?kitchen, or `pnpm build:kitchen`.
 */
import { useState } from 'react'
import { Cloud, Database, Server, Smartphone } from 'lucide-react'
import {
  Callout,
  Chip,
  Compare,
  Cycle,
  Disclosure,
  DisclosureGroup,
  Eyebrow,
  Figure,
  Flow,
  KeyValue,
  Lede,
  Lightbox,
  MarginNote,
  Matrix,
  Morph,
  Page,
  PhoneFrame,
  Picker,
  Prose,
  ScrollStory,
  Section,
  Segmented,
  Sequence,
  Sparkline,
  StageSwitcher,
  Stat,
  StatRow,
  Steps,
  Swimlane,
  Tag,
  Takeaway,
  Timeline,
  Title,
  Tracks,
  Tree,
  type FlowEdge,
  type FlowNode,
} from '@/kit'
import { BarChart, Histogram, LineChart } from '@/kit/charts'
import { Code, Diff } from '@/kit/code'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/kit/ui/tabs'
import { Switch } from '@/kit/ui/switch'
import { Slider } from '@/kit/ui/slider'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/kit/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/kit/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/kit/ui/tooltip'
import { Badge } from '@/kit/ui/badge'

/** A stand-in for a phone screenshot, drawn here so the kit ships no pictures. */
function screen(label: string, hue: number) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844">` +
    `<rect width="390" height="844" fill="hsl(${hue} 18% 12%)"/>` +
    `<rect x="24" y="96" width="210" height="26" rx="8" fill="hsl(${hue} 30% 82%)"/>` +
    [0, 1, 2, 3].map((i) => `<rect x="24" y="${170 + i * 124}" width="342" height="100" rx="20" fill="hsl(${hue} 20% ${18 + i * 2}%)"/>`).join('') +
    `<text x="24" y="60" font-family="system-ui,sans-serif" font-size="20" fill="hsl(${hue} 20% 70%)">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
const spyfinal1 = screen('Lights', 28)
const spyfinal2 = screen('Lights, scroll', 200)
const spya1 = screen('Alarm', 260)
const spyc1 = screen('Profile', 150)
const spyr1 = screen('Results', 340)

/* ─── sample data ─────────────────────────────────────────────────────────── */

const ARCH_NODES: FlowNode[] = [
  { id: 'ios', col: 1, row: 1, title: 'iOS app', sub: 'GoodMorning', icon: Smartphone },
  { id: 'android', col: 2, row: 1, title: 'Android app', sub: 'same protocol', icon: Smartphone },
  { id: 'web', col: 3, row: 1, title: 'Web tools', sub: 'internal only', kind: 'ghost' },
  { id: 'ss3', col: 1, row: 2, span: 2, title: 'OldSync', sub: 'session sync, stats', icon: Server, detail: 'Stays the write path for sessions. After B it writes event blobs to GCS and keeps only a reference in Datastore.' },
  { id: 'api', col: 3, row: 2, title: 'Vault', sub: 'records, revisions', icon: Server, tone: 'teal', kind: 'strong', detail: 'A general backup service. Notes is its first app; Mail moves onto it in C.' },
  { id: 'ds', col: 1, row: 3, title: 'Datastore', sub: 'metadata + events_ref', icon: Database, detail: 'Shrinks from ≈86 TB to ≈10 TB once blobs move out.' },
  { id: 'gcs', col: 2, row: 3, title: 'GCS bucket', sub: 'app-events', icon: Cloud, tone: 'peach', detail: 'Immutable objects named by content hash. Shared by OldSync now and Vault later.' },
  { id: 'sql', col: 3, row: 3, title: 'Cloud SQL', sub: 'records', icon: Database, tone: 'teal' },
]
const ARCH_EDGES: FlowEdge[] = [
  { from: 'ios', to: 'ss3', label: 'sync' },
  { from: 'android', to: 'ss3' },
  { from: 'web', to: 'api', dashed: true, label: 'later' },
  { from: 'ss3', to: 'ds', label: 'metadata' },
  { from: 'ss3', to: 'gcs', label: 'blobs', tone: 'peach' },
  { from: 'api', to: 'sql', tone: 'teal' },
  { from: 'api', to: 'gcs', label: 'same objects', tone: 'teal' },
]

const STAGES = [
  { id: 'today', label: 'Today', caption: 'Every session blob lives inside its Datastore entity, so storage and backups grow together.', path: ['ios', 'android', 'ss3', 'ds'] },
  { id: 'b', label: 'After B', caption: 'OldSync writes blobs to the bucket and keeps a reference; the apps do not change.', path: ['ios', 'android', 'ss3', 'ds', 'gcs'] },
  { id: 'c', label: 'After C', caption: 'New app versions talk to Vault; the objects stay where they are.', path: ['web', 'api', 'sql', 'gcs'] },
]

const latency = Array.from({ length: 400 }, (_, i) => {
  const u = Math.sin(i * 12.9898) * 43758.5453
  const r = u - Math.floor(u)
  const v = Math.sin(i * 78.233) * 12345.678
  const r2 = v - Math.floor(v)
  return Math.max(40, Math.round(120 + Math.sqrt(-2 * Math.log(r + 1e-6)) * Math.cos(2 * Math.PI * r2) * 38 + (i % 17 === 0 ? 160 : 0)))
})

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const storage = months.map((m, i) => ({ m, datastore: Math.round(86 - (i > 5 ? (i - 5) * 11 : 0)), gcs: i > 5 ? Math.min(76, (i - 5) * 11) : 0 }))
const cost = months.slice(0, 8).map((m, i) => ({ m, today: 16 + i * 0.3, after: i < 4 ? 16 + i * 0.3 : 4.1 + i * 0.05 }))

const PATCH = `diff --git a/sleepserver3/session_store.py b/sleepserver3/session_store.py
--- a/sleepserver3/session_store.py
+++ b/sleepserver3/session_store.py
@@ -12,4 +12,8 @@ class SessionEventsStore:
     def put(self, session_id: str, events: bytes) -> None:
-        entity = self.ds.entity(key=self.key(session_id))
-        entity["events"] = events
-        self.ds.put(entity)
+        digest = hashlib.sha256(events).hexdigest()
+        blob = self.bucket.blob(f"events/{digest}")
+        if not blob.exists():
+            blob.upload_from_string(events, if_generation_match=0)
+        entity = self.ds.entity(key=self.key(session_id), exclude_from_indexes=["events_ref"])
+        entity["events_ref"] = digest
+        self.ds.put(entity)
`

/* ─── page ────────────────────────────────────────────────────────────────── */

export default function KitchenSink() {
  const [seg, setSeg] = useState('week')
  const [n, setN] = useState(0)
  const values = ['145k', '152k', '139k']

  return (
    <Page
      indexTitle={
        <>
          <span className="text-strong">Nap kit</span>, every component with sample content
        </>
      }
      indexFooter={
        <span className="inline-flex items-center gap-2">
          <Tag tone="peach" icon="diamond">3</Tag> open questions
        </span>
      }
    >
      <Title eyebrow="Kitchen sink · Recommendation · backend storage">Blobs to GCS now, with Vault on the same buckets.</Title>
      <MarginNote label="Open · billing" title="Check the estimate against the real bill">
        Costs use the list price. Not yet checked against the billing report.
      </MarginNote>
      <Lede>
        Build a <strong>general Vault</strong> with Notes as its first app. At the same time, have OldSync write its event blobs
        into <strong>Vault’s bucket</strong>. Later, Mail moves onto Vault and the objects stay where they are.
      </Lede>

      {/* ── Content ── */}
      <Section eyebrow="Content" title="Numbers, takeaways and notes" lede="Stat, StatRow, Takeaway, Callout, Tag, Chip, MarginNote, KeyValue.">
        <Stat label="Saved per year" tone="orange" size="xl" pre="≈" value="$145k" unit="/yr" note="≈$12k/mo · blobs to GCS plus the unused indexes dropped" />
        <StatRow
          items={[
            { value: '$15–20k', note: 'one-time cost, pays back in ≈2 months' },
            { value: '−88', unit: '%', note: 'Datastore storage, 86 → ≈10 TB' },
            { value: '1', unit: '×', note: 'the bytes move once; C only moves metadata' },
          ]}
        />
        <Takeaway>
          Move the blobs now; it saves money on its own and it is the same layout Vault needs later, so nothing is thrown away.
        </Takeaway>
        <MarginNote label="Open · owners" title="Who owns A and who owns B?">
          The plan only works if they are different people.
        </MarginNote>
        <Prose>
          <p>
            Foundation fixes the project, buckets and object names so both tracks write into the same layout. B starts saving as soon as its
            backfill is done; <em>C later moves only metadata</em>. See the <a href="https://cloud.google.com/storage/pricing">GCS pricing page</a>.
          </p>
        </Prose>
        <Callout kind="question" title="Regional or dual-region bucket?">
          Dual-region doubles the storage line but survives a regional outage. Decide before the backfill starts.
        </Callout>
        <Callout kind="warn">The backfill touches 2.07 B entities. Run it in ramped batches inside transactions.</Callout>
        <Callout kind="good" label="Verified">Datastore backups are on; with ≈10 TB left, they cost little.</Callout>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="peach" icon="diamond">Region</Tag>
          <Tag tone="teal">Ready</Tag>
          <Tag tone="bad" variant="soft">Blocked</Tag>
          <Tag>Draft</Tag>
          <Chip mono>app-events</Chip>
          <Chip tone="teal">Vault</Chip>
          <Chip selected onClick={() => {}}>Selected chip</Chip>
        </div>
        <KeyValue
          cols={2}
          items={[
            { k: 'Bucket', v: 'app-events', mono: true },
            { k: 'Region', v: 'europe-north1', mono: true, note: 'same as Datastore' },
            { k: 'Object name', v: 'events/{sha256}', mono: true },
            { k: 'Retention', v: 'Soft delete, 7 days' },
            { k: 'Owner', v: 'Backend team' },
            { k: 'Commit', v: '9f2c1e4a7b', mono: true },
          ]}
        />
      </Section>

      <Section level={3} title="Disclosure and Steps" lede="Progressive disclosure, and a list for when order matters.">
        <DisclosureGroup>
          <Disclosure label="Why not keep the blobs in Datastore?" meta="cost">
            Datastore bills stored bytes at ≈$0.18/GiB/month against ≈$0.02 for GCS Standard, and every byte is backed up again each day.
          </Disclosure>
          <Disclosure label="What happens to old app versions?" meta="2 notes">
            They keep talking to OldSync, which reads the reference and fetches the object. Nothing changes for them.
          </Disclosure>
          <Disclosure label="Rollback plan">The entity keeps the old field until the backfill is verified, so a rollback is a flag flip.</Disclosure>
        </DisclosureGroup>
        <Disclosure variant="card" label="Card variant, open by default" defaultOpen>
          Use the card variant when a disclosure stands on its own rather than in a list.
        </Disclosure>
        <Steps
          items={[
            { title: 'Create the bucket and IAM', body: 'Soft delete on; OldSync’s service account may write.', meta: 'day 1' },
            { title: 'Write new sessions to the bucket', body: 'Behind a flag, 1 % → 100 % over a week.', tone: 'teal', detail: 'Watch write latency and the error rate on the stats processor; both should stay flat.' },
            { title: 'Backfill 2.07 B entities', body: 'Dataflow, ramped, blobs and indexes in one pass.', detail: 'Each batch is idempotent: objects are named by content hash and written with if_generation_match=0.' },
            { title: 'Drop the old field', body: 'After a full verification pass.', tone: 'good' },
          ]}
        />
      </Section>

      <Section level={3} title="Compare" lede="A table on wide screens; cards on phones. Emphasis marks the recommendation.">
        <Compare
          labelHeader="Aspect"
          emphasis={1}
          columns={[{ label: 'OldSync sync' }, { label: 'Vault', sub: 'recommended', tone: 'teal' }]}
          rows={[
            { label: 'Sync model', cells: ['Whole session on every change', 'Records with revisions and a change feed'] },
            { label: 'Deletes', cells: ['Soft flag, never purged', 'Tombstones, purged after 30 days'] },
            { label: 'Storage', cells: ['Datastore entity per session', 'Cloud SQL rows, blobs in GCS'], note: 'biggest cost line' },
            { label: 'Audio', cells: ['Not supported', 'Signed upload to its own bucket'] },
          ]}
        />
      </Section>

      {/* ── Diagrams ── */}
      <Section eyebrow="Diagrams" title="Flow: boxes on a grid, edges that route themselves" lede="Click a node for its detail. Groups, ghost nodes, icons and labelled edges.">
        <Flow
          title="Where session data goes after B"
          legend={[
            { label: 'write path', kind: 'line' },
            { label: 'later', kind: 'dashed' },
            { label: 'shared bucket', tone: 'peach' },
          ]}
          nodes={ARCH_NODES}
          edges={ARCH_EDGES}
          groups={[{ label: 'Clients', col: 1, row: 1, span: 3 }]}
          caption="Positions are given as col/row; the edges route themselves. Open a node with a plus for its detail."
        />
      </Section>

      <Section level={3} title="Edge labels between neighbours" lede="Default gaps. Labels never cover an arrowhead: gaps grow to fit, long labels wrap, and a label with no room sits beside its line.">
        <Flow
          title="Labelled edges at the default colGap and rowGap"
          nodes={[
            { id: 'a', col: 1, row: 1, title: 'Source', sub: 'sends' },
            { id: 'b', col: 2, row: 1, title: 'Middle', sub: 'passes on' },
            { id: 'c', col: 3, row: 1, title: 'Sink', sub: 'stores' },
            { id: 'd', col: 1, row: 2, title: 'Below', sub: 'vertical edge' },
            { id: 'e', col: 2, row: 2, title: 'Back', sub: 'leftward edge' },
            { id: 'f', col: 3, row: 2, title: 'Both', sub: 'arrow both ways' },
          ]}
          edges={[
            { from: 'a', to: 'b', label: 'cites' },
            { from: 'b', to: 'c', label: 'session records', tone: 'teal' },
            { from: 'a', to: 'd', label: 'executed by' },
            { from: 'e', to: 'd', label: 'template T2', dashed: true },
            { from: 'c', to: 'f', label: 'syncs', arrow: 'both' },
            { from: 'f', to: 'e', label: 'one AHI each', tone: 'peach' },
          ]}
        />
      </Section>

      <Section level={3} title="StageSwitcher" lede="The same diagram in three states. Highlight changes animate.">
        <StageSwitcher stages={STAGES} label="Show">
          {(id) => <Flow nodes={ARCH_NODES} edges={ARCH_EDGES} highlight={STAGES.find((s) => s.id === id)!.path} />}
        </StageSwitcher>
      </Section>

      <Section level={3} title="Picker" lede="Choose an option and see its path.">
        <Picker
          label="Kind of change"
          options={[
            { id: 'minor', label: 'Minor iOS release', sub: 'e.g. 17.4.1 → 17.4.2', path: ['ios', 'ss3', 'ds'] },
            { id: 'model', label: 'New phone model', sub: 'anchor already measured', path: ['ios', 'ss3', 'gcs', 'ds'] },
            { id: 'arch', label: 'New backend', sub: 'Vault cut-over', path: ['web', 'api', 'sql', 'gcs'] },
          ]}
        >
          {(o) => <Flow nodes={ARCH_NODES} edges={ARCH_EDGES} highlight={o.path} />}
        </Picker>
      </Section>

      <Section level={3} title="Tracks" lede="Parallel workstreams with dependencies: 0, then A ∥ B, then C.">
        <Tracks
          joins={['needs 0', 'needs A live + B done']}
          stages={[
            [
              {
                id: 'f',
                badge: '0',
                title: 'Foundation',
                meta: 'unblocks A + B',
                items: [
                  { title: 'GCP project', sub: 'OpenTofu · stage/prod by prefix' },
                  { title: 'Buckets + IAM', sub: 'soft delete · SS3 may write', extra: <Tag tone="peach" icon="diamond">Region</Tag> },
                  { title: 'Object naming fixed', sub: 'immutable · content hash' },
                  { title: 'Drop unused indexes', sub: '−$2.25k/mo · independent', detail: 'SessionStats and SleepScore indexes are never queried; dropping them is a rewrite pass.' },
                ],
              },
            ],
            [
              {
                id: 'a',
                badge: 'A',
                title: 'Notes backup',
                meta: 'at Notes launch',
                tone: 'teal',
                items: [
                  { title: 'Core v1', sub: 'records · revisions · change feed', extra: <Tag tone="peach" icon="diamond">Auth</Tag> },
                  { title: 'Notes profile', sub: 'one record = the full export' },
                  { title: 'iOS sync in the host app', sub: 'uses the export/import API', detail: 'The ARD 1.0 module is unchanged; the host app maps records to its own model.' },
                ],
                outcome: 'Notes live with backup',
              },
              {
                id: 'b',
                badge: 'B',
                title: 'Blobs → bucket',
                meta: '−$12k/mo',
                tone: 'orange',
                items: [
                  { title: 'OldSync writes to GCS', sub: 'events_ref · no write-back' },
                  { title: 'Backfill 2.07 B entities', sub: 'Dataflow · ramped' },
                ],
                outcome: 'Verified: Datastore backups on',
              },
            ],
            [
              {
                id: 'c',
                badge: 'C',
                title: 'Mail → Vault',
                meta: 'retire SS3 sync',
                items: [
                  { title: 'SC profile', sub: 'records point at objects' },
                  { title: 'Metadata → Cloud SQL', sub: '≈2 B rows · partitioned' },
                  { title: 'New app versions', sub: 'edits and deletes sync' },
                  { title: 'Sunset SS3 endpoints', sub: 'once old versions drop off' },
                ],
              },
            ],
          ]}
        />
      </Section>

      <Section level={3} title="Swimlane" lede="Lanes by role, with a dividing line.">
        <Swimlane
          lanes={[
            { id: 'sponsor', label: 'Sponsor', sub: 'freezes inputs' },
            { id: 'op', label: 'Operator', sub: 'audited script', tone: 'teal' },
            { id: 'data', label: 'Study data', sub: 'database, audio' },
            { id: 'ref', label: 'Reference', sub: 'corelab' },
          ]}
          steps={[
            { id: 'build', lane: 'sponsor', col: 1, title: 'Locked build', sub: 'tag, tree hash' },
            { id: 'script', lane: 'sponsor', col: 2, title: 'Prediction script', sub: 'SHA-256 recorded' },
            { id: 'enum', lane: 'op', col: 1, title: 'Enumerate', sub: 'fixed query' },
            { id: 'predict', lane: 'op', col: 2, title: 'Predict', sub: 'CPU only', tone: 'teal' },
            { id: 'record', lane: 'op', col: 3, title: 'Record', sub: 'insert, never overwrite' },
            { id: 'db', lane: 'data', col: 1, title: 'Study database', sub: 'lights times' },
            { id: 'score', lane: 'data', col: 3, title: 'Score table', sub: 'predicted AHI', tone: 'teal' },
            { id: 'psg', lane: 'ref', col: 2, title: 'PSG scoring', sub: 'AASM' },
            { id: 'match', lane: 'ref', col: 3, title: 'Match after lock', sub: '2×2, Se and Sp', tone: 'peach' },
          ]}
          edges={[
            { from: 'build', to: 'predict', label: 'hand-over' },
            { from: 'script', to: 'predict' },
            { from: 'db', to: 'enum', label: 'session list' },
            { from: 'enum', to: 'predict', tone: 'teal' },
            { from: 'predict', to: 'record', tone: 'teal' },
            { from: 'record', to: 'score', tone: 'teal', label: 'AHI' },
            { from: 'psg', to: 'match' },
            { from: 'score', to: 'match', dashed: true },
          ]}
          dividers={[{ after: 'data', label: 'Blinding · the script never reads the reference' }]}
        />
      </Section>

      <Section level={3} title="Sequence" lede="Participants and messages; labels wrap instead of colliding.">
        <Sequence
          numbered
          participants={[
            { id: 'app', label: 'iOS app' },
            { id: 'ss3', label: 'OldSync' },
            { id: 'gcs', label: 'GCS', tone: 'peach' },
            { id: 'ds', label: 'Datastore' },
          ]}
          items={[
            { from: 'app', to: 'ss3', label: 'PUT /session', sub: 'events, 180 kB' },
            { from: 'ss3', to: 'ss3', label: 'sha256(events)' },
            { from: 'ss3', to: 'gcs', label: 'upload if absent', tone: 'peach' },
            { from: 'gcs', to: 'ss3', label: '200 / 412 exists', kind: 'reply' },
            { note: 'Object names are content hashes, so a retry never writes twice.', over: ['ss3', 'gcs'] },
            { from: 'ss3', to: 'ds', label: 'put entity + events_ref' },
            { divider: 'Later' },
            { from: 'ss3', to: 'app', label: '201 Created', kind: 'reply' },
            { from: 'app', to: 'ss3', label: 'GET /stats', kind: 'async' },
          ]}
        />
      </Section>

      <Section level={3} title="Cycle and Timeline">
        <Cycle
          center="every release"
          active={1}
          steps={[
            { title: 'Measure', sub: 'playback next to the baseline' },
            { title: 'Simulate', sub: '251 participants re-scored' },
            { title: 'Decide', sub: 'pass, or not supported' },
            { title: 'Deploy', sub: 'allow-list, no app update' },
            { title: 'Monitor', sub: 'PMS signals' },
          ]}
        />
        <Timeline
          items={[
            { date: 'Mar 3', title: 'Foundation done', state: 'done' },
            { date: 'Apr 14', title: 'B writes live', body: 'New sessions go to the bucket.', state: 'done' },
            { date: 'May 2', title: 'Backfill', body: '2.07 B entities, ramped.', state: 'now' },
            { date: 'Jun', title: 'Notes launch', state: 'next' },
            { date: 'Q4', title: 'C starts', state: 'next' },
          ]}
        />
        <Timeline
          layout="vertical"
          items={[
            { date: '09:12', title: 'Deploy 4.18.0 to 10 %', state: 'done' },
            { date: '09:40', title: 'Error rate up on /stats', body: 'p95 latency doubled for Android clients only.', state: 'risk' },
            { date: '10:05', title: 'Rolled back', state: 'now' },
            { date: 'Next', title: 'Post-mortem', state: 'next' },
          ]}
        />
      </Section>

      <Section level={3} title="Matrix" lede="Cells with states; click a cell with a note.">
        <Matrix
          corner="Model"
          cols={[
            { id: 'g14', label: 'Gen 14' },
            { id: 'g15', label: 'Gen 15' },
            { id: 'g16', label: 'Gen 16' },
            { id: 'g17', label: 'Gen 17' },
          ]}
          rows={[
            { id: 'reg', label: 'Regular', sub: 'regular' },
            { id: 'plus', label: 'Plus', sub: 'regular' },
            { id: 'pro', label: 'Pro', sub: 'max' },
            { id: 'air', label: 'Air', sub: 'own class' },
          ]}
          states={{
            base: { label: 'Baseline', tone: 'neutral', fill: 'solid' },
            measured: { label: 'Measured', tone: 'teal', fill: 'solid' },
            predicted: { label: 'Predicted', fill: 'outline' },
            na: { label: 'n/a', fill: 'hatch' },
          }}
          cells={{
            'reg:g14': { state: 'base' },
            'reg:g15': { state: 'measured', flag: 'tbd', note: 'Anchor for its generation; measured once, then reused for Plus and Pro.' },
            'reg:g16': { state: 'measured' },
            'reg:g17': { state: 'measured' },
            'plus:g14': { state: 'predicted' },
            'plus:g15': { state: 'predicted' },
            'plus:g16': { state: 'predicted' },
            'plus:g17': { state: 'na' },
            'pro:g14': { state: 'predicted' },
            'pro:g15': { state: 'measured', label: 'Class ref' },
            'pro:g16': { state: 'predicted' },
            'pro:g17': { state: 'predicted', note: 'Predicted from Gen 17 Regular plus the Pro class difference.' },
            'air:g14': { state: 'na' },
            'air:g15': { state: 'na' },
            'air:g16': { state: 'na' },
            'air:g17': { state: 'measured', label: 'Class ref' },
          }}
        />
      </Section>

      <Section level={3} title="ScrollStory" lede="A pinned stage that follows the chapters. Inline on phones.">
        <ScrollStory
          chapters={[
            { title: 'Today, blobs live in Datastore.', body: 'Every session entity carries its events, so storage and backups grow together.' },
            { title: 'B moves the bytes once.', body: 'OldSync writes the blob to GCS and keeps a reference. Apps do not notice.' },
            { title: 'C moves only metadata.', body: 'Vault points at the same objects. Nothing is copied twice.' },
          ]}
          stage={(i) => <Flow nodes={ARCH_NODES} edges={ARCH_EDGES} highlight={STAGES[i].path} />}
        />
      </Section>

      {/* ── Data ── */}
      <Section eyebrow="Data" title="Charts on the token palette" lede="Bar, stacked bar, line, area, histogram and an inline sparkline.">
        <BarChart
          title="Storage by month, TB"
          data={storage}
          x="m"
          stacked
          series={[
            { key: 'datastore', label: 'Datastore' },
            { key: 'gcs', label: 'GCS', tone: 'peach' },
          ]}
          unit=" TB"
          caption="Stacked: the total stays flat while it moves to the cheaper store."
        />
        <LineChart
          title="Monthly cost, $k"
          data={cost}
          x="m"
          series={[
            { key: 'today', label: 'Do nothing', dashed: true, tone: 'neutral' },
            { key: 'after', label: 'After B', tone: 'teal' },
          ]}
          reference={{ y: 5, label: 'target', tone: 'good' }}
          dots
        />
        <LineChart area title="Sessions synced per day (M)" data={months.map((m, i) => ({ m, v: 3.1 + Math.sin(i / 2) * 0.4 + i * 0.05 }))} x="m" series={[{ key: 'v', label: 'Sessions' }]} height={180} />
        <BarChart
          horizontal
          title="Indexes by size, TB"
          data={[
            { name: 'SessionStats', v: 12.4 },
            { name: 'SleepScore', v: 9.1 },
            { name: 'events (blob)', v: 61.2 },
            { name: 'Other', v: 3.3 },
          ]}
          x="name"
          series={[{ key: 'v', label: 'Size', tone: 'cream' }]}
        />
        <Histogram title="Write latency, ms" values={latency} bins={28} unit=" ms" markers={[{ x: 120, label: 'median' }, { x: 250, label: 'SLO', tone: 'bad' }]} />
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-3 rounded-2xl border border-line px-5 py-4 text-[14px]">
          <span className="text-quiet">Error rate, 30 days</span>
          <Sparkline values={[3, 4, 3.5, 5, 4.2, 6, 5.5, 4, 3.2, 3, 2.6, 2.4]} tone="teal" width={120} />
          <span className="text-quiet">Backfill throughput</span>
          <Sparkline values={[1, 2, 4, 7, 9, 12, 12, 11, 13, 14, 14, 15]} tone="peach" width={120} />
        </div>
      </Section>

      {/* ── Stateful ── */}
      <Section level={3} title="Segmented and morphing numbers">
        <div className="flex flex-wrap items-center gap-6">
          <Segmented
            value={seg}
            onChange={setSeg}
            options={[
              { id: 'day', label: 'Day' },
              { id: 'week', label: 'Week' },
              { id: 'month', label: 'Month' },
            ]}
            label="Range"
          />
          <button type="button" className="cursor-pointer rounded-full border border-line-strong px-3 py-1.5 text-[13px] text-strong hover:bg-sheer-2" onClick={() => setN((n + 1) % 3)}>
            Change value
          </button>
        </div>
        <Stat label={`Saved per ${seg}`} value={<Morph>{values[n]}</Morph>} pre="≈$" unit="/yr" size="lg" tone="teal" />
      </Section>

      <Section level={3} title="shadcn/ui primitives" lede="Base UI components from src/kit/ui, on the kit tokens.">
        <Tabs defaultValue="plan">
          <TabsList>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="risks">Risks</TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
          </TabsList>
          <TabsContent value="plan" className="pt-3 text-[15px] text-body">Foundation first, then A and B in parallel.</TabsContent>
          <TabsContent value="risks" className="pt-3 text-[15px] text-body">The backfill is the long pole.</TabsContent>
          <TabsContent value="costs" className="pt-3 text-[15px] text-body">≈$15–20k one-time.</TabsContent>
        </Tabs>
        <div className="flex flex-wrap items-center gap-6 text-[14px] text-body">
          <label className="inline-flex items-center gap-2.5">
            <Switch defaultChecked /> Include indexes
          </label>
          <div className="w-48">
            <Slider defaultValue={[40]} max={100} aria-label="Ramp" />
          </div>
          <Select defaultValue="eu" items={{ eu: 'europe-north1', us: 'us-central1' }}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="eu">europe-north1</SelectItem>
                <SelectItem value="us">us-central1</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger className="cursor-pointer rounded-full border border-line-strong px-3 py-1.5 text-[13px] text-strong hover:bg-sheer-2">Popover</PopoverTrigger>
            <PopoverContent className="text-[13.5px]">Soft delete keeps objects for seven days after a delete.</PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger className="cursor-help text-[13.5px] text-strong underline decoration-dotted underline-offset-4">Hover me</TooltipTrigger>
            <TooltipContent>Content-addressed: named by SHA-256.</TooltipContent>
          </Tooltip>
          <Badge variant="secondary">Badge</Badge>
        </div>
      </Section>

      {/* ── Code ── */}
      <Section eyebrow="Code" title="Code, diffs and trees">
        <Code
          title="sleepserver3/session_store.py"
          lang="python"
          lineNumbers
          highlight={[4, 5]}
          code={`class SessionEventsStore:
    def put(self, session_id: str, events: bytes) -> None:
        digest = hashlib.sha256(events).hexdigest()
        blob = self.bucket.blob(f"events/{digest}")
        if not blob.exists():
            blob.upload_from_string(events, if_generation_match=0)  # never overwrite
        self.ds.put(self.entity(session_id, events_ref=digest))
`}
        />
        <Code lang="bash" code={`gcloud storage buckets create gs://app-events \\\n  --location=europe-north1 --soft-delete-duration=7d`} />
        <Diff patch={PATCH} caption="OldSync writes the blob to the bucket and keeps only a reference." />
        <Tree
          title="Repository layout"
          items={[
            {
              name: 'backupapi',
              children: [
                { name: 'core', note: 'records, revisions, change feed', children: [{ name: 'records.py' }, { name: 'tombstones.py', status: 'added' }] },
                { name: 'profiles', children: [{ name: 'notes.py', note: 'first app', tone: 'teal' }, { name: 'mail.py', status: 'added', note: 'track C' }] },
                { name: 'legacy_sync.py', status: 'removed' },
                { name: 'settings.py', status: 'changed' },
              ],
            },
          ]}
        />
      </Section>

      {/* ── Media ── */}
      <Section eyebrow="Media" title="Figures, galleries and phones">
        <Figure src={spyfinal1} alt="A settings screen" caption="Figure with a frame and a caption." credit="iOS, dark" frame />
        <Lightbox
          columns={4}
          aspect="9 / 16"
          images={[
            { src: spyfinal1, label: 'Lights', caption: 'Light settings' },
            { src: spyfinal2, label: 'Lights, scroll', caption: 'Lights and bridge' },
            { src: spya1, label: 'Alarm', caption: 'Alarm settings' },
            { src: spyc1, label: 'Profile', caption: 'Profile' },
            { src: spyr1, label: 'Results', caption: 'Results screen' },
          ]}
        />
        <div className="flex flex-wrap items-start gap-8">
          <PhoneFrame src={spya1} width={220} caption="PhoneFrame with a screenshot" />
          <PhoneFrame width={220} caption="PhoneFrame with live content">
            <div className="flex h-full flex-col gap-3 bg-[#0d0b0a] px-4 pt-14 text-[#eee]">
              <Eyebrow>Tonight</Eyebrow>
              <div className="text-[30px] leading-none font-light tracking-[-0.03em]">
                22:30<span className="text-white/35"> → 06:30</span>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-[13px] text-white/70">Live HTML renders inside the frame.</div>
            </div>
          </PhoneFrame>
        </div>
      </Section>

      {/* ── Prose ── */}
      <Section eyebrow="Prose" title="Plain HTML typography">
        <Prose>
          <p>
            <strong>Prose</strong> styles plain HTML children, so Markdown-ish content reads well without classes. Inline <code>events_ref</code>{' '}
            and <a href="https://example.com">links</a> work.
          </p>
          <h3>A subheading</h3>
          <ul>
            <li>Bucket per environment, prefixed by stage.</li>
            <li>Objects named by content hash, never overwritten.</li>
            <li>Soft delete for seven days.</li>
          </ul>
          <ol>
            <li>Create the bucket.</li>
            <li>Turn on the write flag.</li>
          </ol>
          <blockquote>The bytes move once; everything after only moves metadata.</blockquote>
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Today</th>
                <th>After B</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Datastore</td>
                <td>86 TB</td>
                <td>≈10 TB</td>
              </tr>
              <tr>
                <td>GCS</td>
                <td>0</td>
                <td>≈76 TB</td>
              </tr>
            </tbody>
          </table>
          <pre>
            <code>{`$ pnpm build\n✓ dist/index.html`}</code>
          </pre>
        </Prose>
      </Section>
    </Page>
  )
}

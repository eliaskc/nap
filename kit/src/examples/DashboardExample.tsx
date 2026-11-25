/**
 * Every dashboard part with made-up data, including the loading, empty, error and stale states.
 * `pnpm dev` then open /?dashboard (add &wall for wall mode), or `pnpm build:dashboard`.
 */
import { useState } from 'react'
import { Dashboard, DashGrid, Metric, Panel, RangePicker, useDataset } from '@/kit/dashboard'
import { BarChart, LineChart } from '@/kit/charts'

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const RANGES = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
]

/** Made-up daily numbers, the same every time for a given range. */
function daily(days: number) {
  return Array.from({ length: days }, (_, i) => {
    const wave = Math.sin(i / 3.1) * 40 + Math.sin(i / 11) * 70
    return { day: `Day ${i + 1}`, signups: Math.round(380 + wave + i * 2.5), trials: Math.round(120 + wave / 3 + i) }
  })
}

export default function DashboardExample() {
  const [range, setRange] = useState('30')
  const days = Number(range)

  const signups = useDataset({
    id: 'signups',
    title: 'Signups and trials per day',
    source: 'Made up in the page',
    refresh: 60,
    deps: [days],
    load: async () => {
      await wait(500)
      const rows = daily(days)
      const total = rows.reduce((sum, row) => sum + row.signups, 0)
      return { rows, total, previous: Math.round(total * 0.93), trials: rows.reduce((sum, row) => sum + row.trials, 0) }
    },
  })
  const platforms = useDataset({
    id: 'platforms',
    title: 'Signups by platform',
    source: 'data.json',
    refresh: 0,
    load: async () => {
      await wait(900)
      return [
        { platform: 'iOS', signups: 6120 },
        { platform: 'Android', signups: 4310 },
        { platform: 'Web', signups: 1280 },
      ]
    },
  })
  const refunds = useDataset<Array<{ day: string; refunds: number }>>({
    id: 'refunds',
    title: 'Refunds per day',
    source: 'Collection refunds',
    refresh: 0,
    load: async () => {
      await wait(300)
      return []
    },
  })
  const revenue = useDataset<{ total: number }>({
    id: 'revenue',
    title: 'Revenue',
    source: 'Billing API',
    refresh: 0,
    load: async () => {
      await wait(700)
      throw new Error('You do not have access to revenue')
    },
  })
  // Loads once, then every refresh fails: the old number stays, marked with its age.
  const [loadedOnce, setLoadedOnce] = useState(false)
  const latency = useDataset({
    id: 'latency',
    title: 'Sync latency, p95',
    source: 'Status API',
    refresh: 5,
    staleAfter: 5,
    load: async () => {
      await wait(200)
      if (loadedOnce) throw new Error('The status API did not answer')
      setLoadedOnce(true)
      return { p95: 212, previous: 240 }
    },
  })

  return (
    <Dashboard eyebrow="Kit example" title="Signups" range={<RangePicker options={RANGES} value={range} onChange={setRange} />}>
      <DashGrid cols={4}>
        <Metric dataset={signups} label="Signups" value={(d) => d.total} compare={(d) => d.previous} />
        <Metric dataset={signups} label="Trials started" value={(d) => d.trials} note="of all signups" />
        <Metric dataset={latency} label="Sync latency, p95" value={(d) => d.p95} compare={(d) => d.previous} unit=" ms" goodWhen="down" compareLabel="on last week" />
        <Metric dataset={revenue} label="Revenue" value={(d) => d.total} pre="$" />
      </DashGrid>
      <DashGrid cols={3}>
        <Panel title={`Signups and trials per day, last ${days} days`} dataset={signups} span={2}>
          {(d) => (
            <LineChart
              data={d.rows}
              x="day"
              height={260}
              series={[
                { key: 'signups', label: 'Signups' },
                { key: 'trials', label: 'Trials' },
              ]}
            />
          )}
        </Panel>
        <Panel title="Signups by platform" note="All time" dataset={platforms}>
          {(rows) => <BarChart data={rows} x="platform" height={260} series={[{ key: 'signups', label: 'Signups' }]} />}
        </Panel>
        <Panel title="Refunds per day" dataset={refunds} emptyText="No refunds in this range">
          {(rows) => <BarChart data={rows} x="day" series={[{ key: 'refunds' }]} />}
        </Panel>
        <Panel title="Revenue per day" dataset={revenue} span={2}>
          {() => null}
        </Panel>
      </DashGrid>
    </Dashboard>
  )
}

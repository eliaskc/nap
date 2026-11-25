import '../index.css'
import './deck.css'
import { mountIslands } from '@/kit/slides'
import { LineChart } from '@/kit/charts'

// Islands: the parts of a slide that are drawn by code. Each name here fills the elements with
// that data-island in slides.html. Everything else on a slide is plain HTML. Delete this file's
// islands, and the charts import, when the deck has none.
const weeks = Array.from({ length: 12 }, (_, i) => ({ week: `W${i + 1}`, share: Math.round(24 + i * 1.4 + Math.sin(i / 1.6) * 3) }))

mountIslands({
  // Made-up numbers. For live ones, load them here: useDataset from '@/kit/dashboard' works in an island.
  trend: () => <LineChart data={weeks} x="week" series={[{ key: 'share', label: 'Share' }]} unit=" %" height={230} />,
})

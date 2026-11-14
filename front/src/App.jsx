import { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Fix for the broken Leaflet marker icons with Vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// Empty = same server (dev proxy). Set VITE_API_URL when the backend is deployed elsewhere.
const API_URL = import.meta.env.VITE_API_URL || ''

// ---- helpers ----
async function api(path, opts) {
  const res = await fetch(API_URL + path, opts)
  if (!res.ok) {
    let msg = `Request failed: ${res.status}`
    try { msg = (await res.json()).detail || msg } catch (_) {}
    throw new Error(msg)
  }
  return res.json()
}

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const pct = v => (v == null || Number.isNaN(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(0)}%`)

// Criteria used to rank the rotations (higher value = better rank)
const FOCUS = [
  { key: 'overall', label: 'overall score', value: c => c.score },
  { key: 'water', label: 'water', value: c => -c.water_total_mm },
  { key: 'nitrogen', label: 'nitrogen', value: c => c.n_balance_kg },
  { key: 'resilience', label: 'resilience', value: c => c.resilience_avg },
  { key: 'soil', label: 'soil', value: c => c.soil_protection_avg },
  { key: 'economy', label: 'economy', value: c => c.economic_potential_avg },
]

// Same crops as rotation A: the backend always compares A, B and C
const COMPARE_BODY = {
  crops: ['winter_wheat', 'winter_wheat', 'winter_wheat'],
  climate: { temp_shift: 0, precipitation: 1, drought: 0 },
}

// ---- Rank badge ----
function RankBadge({ rank }) {
  const cls = { 1: 'rank-1', 2: 'rank-2', 3: 'rank-3' }[rank] || ''
  return <span className={`rank-badge ${cls}`}>{rank}</span>
}

// ---- Map component ----
function FieldMap({ field }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !field) return
    const m = L.map(ref.current).setView([field.lat, field.lon], 12)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(m)

    // Circle with the real area of the field (area = π r²)
    L.circle([field.lat, field.lon], {
      color: '#0b6e4f',
      fillColor: '#0b6e4f',
      fillOpacity: 0.25,
      weight: 3,
      radius: Math.sqrt((field.area_ha * 10000) / Math.PI),
    }).addTo(m)

    L.marker([field.lat, field.lon])
      .addTo(m)
      .bindPopup(
        `<b>${field.name}</b><br>${field.region ?? ''}<br>${field.area_ha} ha · ${field.irrigation ?? ''} · ${field.terrain ?? ''}`
      )

    return () => m.remove() // clean up, so the map is not created twice
  }, [field])

  return <div ref={ref} className="map-wrap" />
}

// ---- Seed data (with a minimal offline fallback) ----
async function demoSeed() {
  try {
    return await api('/api/demo/seed.json')
  } catch (_) {
    return {
      fields: [{
        id: 'SET-001', name: 'Settat demo field', region: 'Settat region, Morocco',
        lat: 32.75, lon: -8.05, area_ha: 10.0, irrigation: 'rainfed', terrain: 'flat',
      }],
      scenarios: [
        { id: 'historical', label: 'Historical baseline', temp_shift: 0.0, precipitation: 1.0, drought: 0.0 },
        { id: 'mild_warming_wet', label: 'Mild warming + wetter', temp_shift: 1.0, precipitation: 1.05, drought: 0.0 },
        { id: 'severe_drying', label: 'Severe drying', temp_shift: 1.8, precipitation: 0.78, drought: 0.35 },
        { id: 'hot_wet', label: 'Hot + wet', temp_shift: 2.2, precipitation: 1.12, drought: 0.10 },
      ],
    }
  }
}

// ---- Main App ----
export default function App() {
  const [field, setField] = useState(null)
  const [scenarios, setScenarios] = useState([])
  const [focus, setFocus] = useState('overall')
  const [activeScenario, setActiveScenario] = useState('historical')
  const [comparison, setComparison] = useState(null)
  const [nasaData, setNasaData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadDemo = useCallback(async () => {
    const seed = await demoSeed()
    setField(seed.fields?.[0] ?? null)
    setScenarios(seed.scenarios ?? [])
  }, [])

  useEffect(() => {
    loadDemo().finally(() => setLoading(false))
    // NASA data loads in the background (it can be slow on the first call)
    api('/api/nasa').then(setNasaData).catch(() => setNasaData(null))
  }, [loadDemo])

  // Run the comparison once the field is known
  useEffect(() => {
    if (!field) return
    const ctrl = new AbortController()
    setError(null)
    api('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(COMPARE_BODY),
      signal: ctrl.signal,
    })
      .then(setComparison)
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => ctrl.abort()
  }, [field])

  if (loading || !field) {
    return (
      <div className="app">
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          Loading field &amp; engine…
        </div>
      </div>
    )
  }

  const sc = scenarios.find(s => s.id === activeScenario) || scenarios[0]
  const scId = sc?.id
  const sliderIndex = Math.max(0, scenarios.findIndex(s => s.id === scId))
  const focusValue = (FOCUS.find(f => f.key === focus) || FOCUS[0]).value

  // Rotations for the selected scenario, sorted by the chosen criterion
  const scenarioRows = (comparison?.comparison ?? [])
    .filter(c => c.scenario_id === scId)
    .sort((a, b) => focusValue(b) - focusValue(a))
  const best = scenarioRows[0]

  const ranked = comparison?.ranked ?? []
  const flipIds = comparison?.climate_flip?.flipping_scenarios ?? []
  const flipLabels = flipIds.map(id => scenarios.find(s => s.id === id)?.label ?? id)

  return (
    <div className="app">
      <header className="header">
        <h1>NEX TERRA — Rotation Resilience Engine</h1>
        <p>Satellite + soil + crop science. Don't just predict the next harvest. <strong>Engineer the next five years.</strong></p>
        <span className="tagline">Morocco · Settat demo field</span>
      </header>

      <div className="layout">
        {/* left: map + problems */}
        <div>
          <FieldMap field={field} />
          <div className="card">
            <h2>Selected field</h2>
            <p className="sub">{field.name}{field.region ? ` · ${field.region}` : ''}</p>
            <p className="sub">{field.area_ha} ha · irrigation: <strong>{field.irrigation}</strong></p>
            <div className="problems">
              <span className="problem-chip">Drought &amp; water scarcity</span>
              <span className="problem-chip">Soil nutrient depletion</span>
              <span className="problem-chip">Soil degradation</span>
              <span className="problem-chip">Climate uncertainty</span>
            </div>
          </div>
        </div>

        {/* right: comparison dashboard */}
        <div>
          <div className="card">
            <h2>Which rotation survives the next five years?</h2>
            <p className="sub">
              <strong>A. Continuous cereal · B. Cereal–legume · C. Diversified</strong>{' '}
              across future climate scenarios.
            </p>

            {error && <div className="error-box">⚠ Could not load the comparison: {error}</div>}
            {!comparison && !error && <div className="sub">Computing the comparison…</div>}

            <label className="slider-label">Future climate scenario (NEX-GDDP-CMIP6 deltas)</label>
            <input
              type="range"
              min={0}
              max={Math.max(0, scenarios.length - 1)}
              value={sliderIndex}
              onChange={e => setActiveScenario(scenarios[Number(e.target.value)].id)}
              className="scenario-slider"
            />

            <div className="sub" style={{ marginTop: 10 }}>Rank the rotations by:</div>
            <div className="priorities">
              {FOCUS.map(f => (
                <button
                  key={f.key}
                  className={`prio-btn ${f.key === focus ? 'active' : ''}`}
                  onClick={() => setFocus(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {sc && (
              <div className="future-banner">
                <p><strong>{sc.label ?? String(sc.id).replace(/_/g, ' ')}</strong></p>
                <p>
                  +{num(sc.temp_shift, 1)}°C warming · precipitation{' '}
                  {sc.precipitation >= 1 ? '+' : ''}{Math.round((sc.precipitation - 1) * 100)}% ·
                  drought index {num(sc.drought, 2)}
                </p>
                {best && (
                  <div className="impacts">
                    <span className="impact">best here: {best.rotation_label}</span>
                    <span className="impact">water {num(best.water_total_mm)} mm</span>
                    <span className="impact">resilience {pct(best.resilience_avg)}</span>
                  </div>
                )}
              </div>
            )}

            {nasaData && (
              <div className="card" style={{ padding: '12px 14px', background: '#f4faf6' }}>
                <div className="sub" style={{ fontWeight: 700, marginBottom: 6 }}>
                  Satellite observations (NEX TERRA)
                  {nasaData._synthetic && <span className="synthetic-badge">synthetic data</span>}
                </div>
                <div className="sub">
                  <b>Surface temp:</b> {num(nasaData.temp_mean_c, 2)} °C ·{' '}
                  <b>Rainfall:</b> {num(nasaData.rainfall_mm_tot, 1)} mm ·{' '}
                  <b>Sun hours:</b> {num(nasaData.sun_hours, 1)} ·{' '}
                  <b>Humidity:</b> {num(nasaData.humidity_pct)}%
                </div>
                <div className="sub">
                  <b>Vegetation (EVI):</b> {num(nasaData.evi, 3)} ·{' '}
                  <b>Soil moisture (SMAP):</b> {num(nasaData.sm, 3)} ·{' '}
                  <b>Future warming (CMIP6):</b> +{num(nasaData.cmip6?.temp_mean_c, 1)}°C
                </div>
                <div className="sub" style={{ fontSize: 12, color: '#4a5c74' }}>
                  {nasaData._synthetic
                    ? (nasaData.source_note || 'Synthetic fallback series (NASA servers not reachable).')
                    : (nasaData.source_note || 'Observed window: 2019–2024.')}
                </div>
              </div>
            )}

            {comparison && (
              <>
                <div className="sub" style={{ margin: '14px 0 8px' }}>
                  Rotations under <strong>{sc?.label}</strong>, ranked by{' '}
                  <strong>{FOCUS.find(f => f.key === focus)?.label}</strong>.
                </div>
                <div className="comp-wrap">
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th>Rank</th><th>Rotation</th><th>Crops</th><th>Water (mm)</th>
                        <th>N (kg/ha)</th><th>Resilience</th><th>Soil</th>
                        <th>Economy (MAD)</th><th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scenarioRows.map((c, i) => (
                        <tr key={`${c.rotation_id}-${c.scenario_id}`}>
                          <td><RankBadge rank={i + 1} /></td>
                          <td><strong>{c.rotation_label}</strong></td>
                          <td>{(c.rotation ?? []).join(' · ')}</td>
                          <td>{num(c.water_total_mm)}</td>
                          <td>{num(c.n_balance_kg, 1)}</td>
                          <td>{pct(c.resilience_avg)}</td>
                          <td>{pct(c.soil_protection_avg)}</td>
                          <td>{num(c.economic_potential_avg)}</td>
                          <td>{num(c.score, 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {ranked.length > 0 && (
                  <>
                    <div className="sub" style={{ marginTop: 16, marginBottom: 6 }}>
                      Overall ranking across all climate scenarios (mean score):
                    </div>
                    {ranked.map(r => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                        <RankBadge rank={r.rank} />
                        <strong>{r.label}</strong>
                        <span className="sub" style={{ margin: 0 }}>
                          mean {num(r.mean_score, 3)} · worst case {num(r.worst_score, 3)}
                        </span>
                      </div>
                    ))}
                  </>
                )}

                {flipLabels.length > 0 && (
                  <div className="sub" style={{ marginTop: 10 }}>
                    ⚠ The best rotation changes under: <strong>{flipLabels.join(', ')}</strong>.
                  </div>
                )}

                <div className="sub" style={{ marginTop: 16, marginBottom: 6 }}>
                  General agronomic expectations (not computed by the engine, compare with the results above):
                </div>
                <div className="explanations">
                  <div className="expl">
                    <h3>A · Continuous cereal</h3>
                    <p>Risk of pest/disease build-up and soil nutrient mining. Highest water use.</p>
                  </div>
                  <div className="expl">
                    <h3>B · Cereal–legume rotation</h3>
                    <p>Legume fixes nitrogen, breaks pest cycles, cuts fertiliser need.</p>
                  </div>
                  <div className="expl">
                    <h3>C · Diversified rotation</h3>
                    <p>Better soil protection and diversity, but higher capital and water demand.</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

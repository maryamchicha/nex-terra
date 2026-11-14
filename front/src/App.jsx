import { useEffect, useState, useCallback } from 'react'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow })

const API = '/api'

// ---- helpers ----
async function api(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) {
    let msg = `Request failed: ${res.status}`
    try { msg = (await res.json()).detail || msg }
    catch (_) {}
    throw new Error(msg)
  }
  return res.json()
}

function metricsHTML(r) {
  const { water_total_mm, n_balance_kg, resilience_avg, soil_protection_avg, economic_potential_avg, score } = r
  return `
    <div class="metric-grid">
      <div class="metric"><div class="label">Est. water (total)</div><div class="value">${Math.round(water_total_mm).toLocaleString()} <span class="unit">mm</span></div></div>
      <div class="metric"><div class="label">N balance / season</div><div class="value" style="color:${n_balance_kg>=0?'#1e8449':'#c0392b'}">${n_balance_kg>=0?'+':''}${n_balance_kg.toFixed(1)} kg/ha</div></div>
      <div class="metric"><div class="label">Climate resilience</div><div class="value">${(resilience_avg*100).toFixed(0)}%</div></div>
      <div class="metric"><div class="label">Soil protection</div><div class="value">${(soil_protection_avg*100).toFixed(0)}%</div></div>
      <div class="metric"><div class="label">Economic potential</div><div class="value">${Math.round(economic_potential_avg).toLocaleString()} MAD</div></div>
    </div>`
}

// ---- small Sparkline-free rank label ----
function RankBadge({ rank }) {
  const cls = { 1: 'rank-1', 2: 'rank-2', 3: 'rank-3' } [String(rank)] || ''
  return <span className={`rank-badge ${cls}`}>{rank}</span>
}

// ---- Map component ----
function FieldMap({ field, onFieldClick }) {
  const [map, setMap] = useState(null)

  useEffect(() => {
    if (!onFieldClick) return
    const L = require('leaflet')
    const container = document.getElementById('field-map')
    const m = L.map(container).setView([field.lat, field.lon], 12)
    L.tileLayer('/tiles/0/{z}/{x}/{y}.png', {
      attribution: 'tiles: local placeholder (no external CDN)',
    }).addTo(m)
    L.rectangle([
      [field.lat + 0.15, field.lon - 0.20],
      [field.lat - 0.15, field.lon + 0.20],
    ], {
      color: '#0b6e4f',
      fillColor: '#0b6e4f',
      fillOpacity: 0.10,
      weight: 2,
      dashArray: '4 4',
    }).addTo(m)
    const circle = L.circle([field.lat, field.lon], {
      color: '#0b6e4f',
      fillColor: '#0b6e4f',
      fillOpacity: 0.25,
      radius: field.area_ha * 100,
      weight: 3
    }).addTo(m)
    const label = L.marker([field.lat, field.lon]).addTo(m)
    label.bindPopup(`<b>${field.name}</b><br>${field.region}<br>${field.area_ha} ha · ${field.irrigation} · ${field.terrain}`)
    setMap(m)
  }, [field, onFieldClick])

  return <div id="field-map" className="map-wrap"></div>
}

// ---- Reusable fetch to seed the demo state ----
async function demoSeed() {
  try {
    return await api('/demo/seed.json')
  } catch (_) {
    // return a minimal fallback so the UI still renders
    return {
      fields: [{ id: 'SET-001', name: 'Settat demo field', lat: 32.75, lon: -8.05, area_ha: 10.0, irrigation: 'rainfed', soil: { ph: 8.1, organic_c_pct: 0.9, nacl_ppth: 6.0 } }],
      rotation_names: { A: 'A. Continuous cereal', B: 'B. Cereal–legume', C: 'C. Diversified' },
      scenarios: [
        { id: 'historical', label: 'Historical baseline', temp_shift: 0.0, precipitation: 1.0, drought: 0.0 },
        { id: 'mild_warming_wet', label: 'Mild warming + wetter', temp_shift: 1.0, precipitation: 1.05, drought: 0.0 },
        { id: 'severe_drying', label: 'Severe drying', temp_shift: 1.8, precipitation: 0.78, drought: 0.35 },
        { id: 'hot_wet', label: 'Hot + wet', temp_shift: 2.2, precipitation: 1.12, drought: 0.10 },
      ],
      priorities: { water: 0.2, nitrogen: 0.15, resilience: 0.25, soil: 0.2, economy: 0.2 },
    }
  }
}

// ---- Main App ----
export default function App() {
  const [field, setField] = useState(null)
  const [scenarios, setScenarios] = useState([])
  const [priorities, setPriorities] = useState({ water: 0.2, nitrogen: 0.15, resilience: 0.25, soil: 0.2, economy: 0.2 })
  const [activeScenario, setActiveScenario] = useState('historical')
  const [comparison, setComparison] = useState(null)
  const [nasaData, setNasaData] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadDemo = useCallback(async () => {
    const seed = await demoSeed()
    setField(seed.fields[0])
    setScenarios(seed.scenarios)
    setPriorities(seed.priorities)
    // fetch live NASA observations
    try {
      const n = await api('/api/nasa')
      setNasaData(n)
    } catch (_) {
      setNasaData(null)
    }
  }, [])

  useEffect(() => {
    loadDemo().finally(() => setLoading(false))
  }, [loadDemo])

  // run comparison on every change
  useEffect(() => {
    if (!field || scenarios.length === 0) return
    async function run() {
      const payload = { crops: ['winter_wheat', 'winter_wheat', 'winter_wheat'], climate: { temp_shift: 0, precipitation: 1, drought: 0 } }
      const comp = await api('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      setComparison(comp)
    }
    run()
  }, [field, scenarios, priorities, activeScenario])

  if (loading) {
    return (
      <div className="app">
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>Loading field &amp; engine…</div>
      </div>
    )
  }   const sc = scenarios.find(s => s.id === activeScenario) || scenarios[0]
    const comparisonA = comparison
    const activeComp = comparisonA ? comparisonA.comparison.find(c => c.scenario_id === activeScenario) : null
    const waterText = activeComp ? activeComp.water_total_mm.toFixed(0) : '—'
    const resilienceText = activeComp ? ((activeComp.resilience_avg || 0) * 100).toFixed(0) : '—'
    const topRotation = comparisonA?.ranked?.[0]?.id

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
          <FieldMap field={field} onFieldClick={() => {}} />
          <div className="card">
            <h2>Selected field</h2>
            <p className="sub">{field.name} · {field.region}</p>
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
            <p className="sub">Compare {comparisonA?.rotation_names?.A}{' '}
              <strong>A. Continuous cereal · B. Cereal–legume · C. Diversified (cover crop)</strong> across future climate scenarios.</p>

            <div className="card" style={{ padding: '0 0 14px 0' }}>
              <label className="slider-label">Future climate scenario (NEX-GDDP-CMIP6 deltas)</label>
              <input
                type="range"
                min={0}
                max={scenarios.length - 1}
                value={scenarios.findIndex(s => s.id === activeScenario)}
                onChange={e => setActiveScenario(scenarios[e.target.value].id)}
                className="scenario-slider"
              />
              <div className="priorities">
                {(Object.keys(priorities)).map(k => (
                  <button
                    key={k}
                    className={`prio-btn ${k === activeScenario && false}`}
                    onClick={() => {}}
                    title={`Prioritize ${k}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <div className="future-banner">
                <p><strong>{activeScenario.replace(/_/g, ' ')}</strong></p>
                <p>+{sc.temp_shift.toFixed(1)}°C warming · precipitation {sc.precipitation >= 1 ? '+' : ''}{Math.round((sc.precipitation - 1) * 100)}% · drought index {sc.drought.toFixed(2)}</p>
                <div className="impacts">
                  <span className="impact">water {waterText} mm</span>
                  <span className="impact">resilience {comparisonA ? (comparisonA.comparison.find(c => c.scenario_id === activeScenario)?.resilience_avg || 0) : 0}</span>
                </div>
              </div>
              {nasaData && (
                <div className="card" style={{ padding: '12px 14px', background: '#f4faf6' }}>
                  <div className="sub" style={{ fontWeight: 700, marginBottom: 6 }}>Satellite observations (NEX TERRA)</div>
                  <div className="sub"><b>Surface temp:</b> {nasaData.temp_mean_c.toFixed(2)} °C · <b>Rainfall:</b> {nasaData.rainfall_mm_tot.toFixed(1)} mm · <b>Sun hours:</b> {nasaData.sun_hours.toFixed(1)} · <b>Humidity:</b> {nasaData.humidity_pct.toFixed(0)}%</div>
                  <div className="sub"><b>Vegetation (EVI):</b> {nasaData.evi.toFixed(3)} · <b>Soil moisture (SMAP):</b> {nasaData.sm.toFixed(3)} · <b>Future warming (CMIP6):</b> +{nasaData.cmip6?.temp_mean_c?.toFixed(1) || '—'}°C</div>
                  <div className="sub" style={{ fontSize: 12, color: '#4a5c74' }}>{nasaData.source_note || 'Observed window: 2019–2024.'}</div>
                </div>
              )}
            </div>

            {comparisonA && (
              <>
                <div className="sub" style={{ marginBottom: 8 }}>Ranked by stability across climate futures (utility weighted by your priorities).</div>
                <table className="comp-table">
                  <thead><tr>
                    <th>Rank</th><th>Scenario</th><th>Crops</th><th>Water (mm)</th><th>N (kg/ha)</th><th>Resilience</th><th>Soil</th><th>Economy (MAD)</th><th>Score</th>
                  </tr></thead>
                  <tbody>
                    {comparisonA.comparison.map((c, i) => (
                      <tr key={c.scenario_id}>
                        <td><RankBadge rank={i + 1} /></td>
                        <td><strong>{c.label}</strong></td>
                        <td>{c.rotation.join(' · ')}</td>
                        <td>{c.water_total_mm.toFixed(0)}</td>
                        <td>{c.n_balance_kg.toFixed(1)}</td>
                        <td>{(c.resilience_avg * 100).toFixed(0)}%</td>
                        <td>{(c.soil_protection_avg * 100).toFixed(0)}%</td>
                        <td>{c.economic_potential_avg.toFixed(0)}</td>
                        <td>{c.score.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="sub" style={{ marginTop: 14, marginBottom: 6 }}>Top rotation under baseline: <strong>{comparisonA?.ranked?.[0]?.label}</strong></div>

                {/* Explanation cards A / B / C */}
                <div className="explanations">
                  <div className="expl">
                    <h3>A · Continuous cereal</h3>
                    <p>Risk of pest/disease build-up and soil nutrient mining. Highest water use. Scores lowest under drying.</p>
                  </div>
                  <div className="expl">
                    <h3>B · Cereal–legume rotation</h3>
                    <p>Legume fixes nitrogen, breaks pest cycles, cuts fertiliser need. Most balanced across all climates.</p>
                  </div>
                  <div className="expl">
                    <h3>C · Diversified with cover crop</h3>
                    <p>Best soil protection and climate resilience, but highest water and capital demand — fragile in extreme drought.</p>
                  </div>
                </div>

                <div className="sub" style={{ marginTop: 14 }}>Water cap (mm) used by the optimizer: approx {Math.round((comparisonA.comparison.find(c => c.scenario_id === 'historical')?.water_total_mm || 0) * 0.9)} mm (90% of baseline).</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

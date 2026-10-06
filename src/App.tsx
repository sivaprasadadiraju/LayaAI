import { useEffect, useMemo, useState } from 'react'
import './App.css'

type ModelChoice = 'auto' | 'english' | 'multilingual' | 'typed-decisions'
type Question = { type: 'choice' | 'score' | 'noul'; instructions: string; criteria?: Record<string, string> | string[]; labels?: Record<string, string> }
type Prediction = { answers?: Record<string, Record<string, unknown>>; routing?: Record<string, unknown>; usage?: Record<string, unknown> }
type Evaluation = { count: number; accuracy: number; ece: number; coverage: number; selective_accuracy: number | null; threshold: number; confusion_matrix: Record<string, Record<string, number>>; rows: Array<{ text: string; expected: string; prediction: string | null; confidence: number; correct: boolean; automated: boolean }> }

const examples = {
  duplicate: { subject: 'Duplicate charge', body: 'We were billed twice for March. Please refund the duplicate today or we will cancel our plan.' },
  outage: { subject: 'Application error', body: 'The dashboard returns a 500 error every time our team tries to sign in. This is blocking our work.' },
  sales: { subject: 'Team plan question', body: 'We are evaluating Laya for 80 employees. Could someone share enterprise pricing and contract details?' },
}

const triageQuestions: Record<string, Question> = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this request based on the reported issue?',
    criteria: { billing: 'invoices, payments, charges, and refunds', technical: 'bugs, outages, access, and system errors', sales: 'pricing, plans, and new contracts', other: 'anything that does not fit another category' },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this support request?',
    criteria: ['routine; no immediate impact', 'soon; action needed within one business day', 'blocking; critical deadline or work stopped'],
  },
  churn_risk: {
    type: 'noul',
    instructions: 'Does the customer explicitly threaten to cancel or leave?',
    criteria: { false: 'the customer does not threaten to cancel or leave', true: 'the customer explicitly threatens to cancel or leave' },
    labels: { false: 'B', true: 'A' },
  },
  refund_requested: {
    type: 'noul',
    instructions: 'Does the customer explicitly ask for a refund?',
    criteria: { false: 'the customer does not ask for money back', true: 'the customer explicitly asks for a refund' },
    labels: { false: 'B', true: 'A' },
  },
}

const evalCriteria = {
  billing: 'invoices, payments, charges, and refunds',
  technical: 'bugs, outages, access, and system errors',
  sales: 'pricing, plans, and new contracts',
  other: 'anything that does not fit another category',
}

const sampleEvaluation = [
  { text: 'I was charged twice for my subscription. Please refund the extra payment.', expected: 'billing' },
  { text: 'The app crashes when I open the reports page.', expected: 'technical' },
  { text: 'Can you send me pricing for a 25-person team?', expected: 'sales' },
  { text: 'I cannot log in after resetting my password; I keep getting an error.', expected: 'technical' },
  { text: 'There is a tax amount missing from the invoice we paid yesterday.', expected: 'billing' },
  { text: 'Do you offer annual plans for larger companies?', expected: 'sales' },
]

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14Z" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    chart: <><path d="M4 19V5m0 14h17" /><path d="m7 15 4-4 3 2 6-7" /></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10" /></>,
    play: <path d="m8 5 12 7-12 7V5Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    down: <path d="m7 10 5 5 5-5" />,
    code: <><path d="m8 17-5-5 5-5m8 10 5-5-5-5m-2-7-4 20" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Check that the Laya service is running.' }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : `Request failed (${response.status})`)
  return payload as T
}

function App() {
  const [section, setSection] = useState<'playground' | 'evaluation'>('playground')
  const [model, setModel] = useState<ModelChoice>('auto')
  const [stateText, setStateText] = useState(JSON.stringify(examples.duplicate, null, 2))
  const [result, setResult] = useState<Prediction | null>(null)
  const [evaluationText, setEvaluationText] = useState(JSON.stringify(sampleEvaluation, null, 2))
  const [threshold, setThreshold] = useState(0.7)
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [serviceOnline, setServiceOnline] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)

  const stateValidation = useMemo(() => {
    try { const parsed = JSON.parse(stateText); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? '' : 'State must be a JSON object.' }
    catch { return 'Check the JSON syntax in your state.' }
  }, [stateText])

  useEffect(() => {
    let alive = true
    const check = () => fetch('/api/health').then((response) => { if (!response.ok) throw new Error('offline'); return response.json() }).then(() => { if (alive) setServiceOnline(true) }).catch(() => { if (alive) setServiceOnline(false) })
    void check()
    const timer = window.setInterval(check, 8000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  async function runDecision() {
    if (stateValidation) { setError(stateValidation); return }
    setBusy(true); setError(''); setResult(null)
    try {
      const state = JSON.parse(stateText) as Record<string, unknown>
      const response = await post<Prediction>('/api/predict', { state, questions: triageQuestions, ...(model === 'auto' ? {} : { model }) })
      setResult(response)
    } catch (requestError) { setError(messageOf(requestError)) }
    finally { setBusy(false) }
  }

  async function runEvaluation() {
    setBusy(true); setError(''); setEvaluation(null)
    try {
      const examplesToRun = JSON.parse(evaluationText) as Array<{ text: string; expected: string }>
      if (!Array.isArray(examplesToRun) || examplesToRun.length === 0) throw new Error('Add at least one evaluation example.')
      const response = await post<Evaluation>('/api/evaluate', { examples: examplesToRun, criteria: evalCriteria, instructions: 'Which team should handle this customer request based on the reported issue?', threshold, ...(model === 'auto' ? {} : { model }) })
      setEvaluation(response)
    } catch (requestError) { setError(messageOf(requestError)) }
    finally { setBusy(false) }
  }

  function loadExample(key: keyof typeof examples) {
    setStateText(JSON.stringify(examples[key], null, 2)); setResult(null); setError('')
  }

  const answers = result?.answers ?? {}
  const routingModel = result?.routing?.model
  const latency = result?.usage?.latency_ms ?? result?.usage?.elapsed_ms

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-symbol"><Icon name="spark" size={18} /></div><span>laya<span className="brand-period">.</span></span><span className="poc-tag">POC</span></div>
        <div className="sidebar-caption">WORKSPACE</div>
        <button className={`nav-item ${section === 'playground' ? 'active' : ''}`} onClick={() => { setSection('playground'); setError('') }}><Icon name="grid" size={17} />Decision studio</button>
        <button className={`nav-item ${section === 'evaluation' ? 'active' : ''}`} onClick={() => { setSection('evaluation'); setError('') }}><Icon name="chart" size={17} />Evaluate a dataset</button>
        <div className="sidebar-note"><div className="note-icon"><Icon name="shield" size={16} /></div><div><strong>Local-first decisions</strong><p>Your text stays on this machine. The first run downloads model weights from Hugging Face.</p></div></div>
        <div className="sidebar-footer"><span className={`service-dot ${serviceOnline ? 'online' : ''}`} /><span>{serviceOnline ? 'Local model service ready' : 'Model service not connected'}</span></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div className="breadcrumbs">Laya POC <span>/</span> {section === 'playground' ? 'Decision studio' : 'Evaluation'}</div><div className="topbar-right"><div className={`connection-status ${serviceOnline ? 'connected' : ''}`}><span />{serviceOnline ? 'API connected' : 'API offline'}</div><span className="version-tag">Laya local</span></div></header>

        <div className="page-wrap">
          <section className="page-heading"><div><div className="overline">TYPED DECISIONS · LOCAL INFERENCE</div><h1>{section === 'playground' ? 'Decision studio' : 'Evaluate your workflow'}</h1><p>{section === 'playground' ? 'Give Laya a state and a few clear questions. Get structured answers in one model call.' : 'Measure routing quality and confidence on a small, labeled sample before you trust it.'}</p></div><div className="model-select-wrap"><label htmlFor="model-choice">CHECKPOINT</label><div className="select-shell"><select id="model-choice" value={model} onChange={(event) => setModel(event.target.value as ModelChoice)}><option value="auto">Auto · Router</option><option value="english">Laya English</option><option value="multilingual">Laya multilingual</option><option value="typed-decisions">Typed decisions</option></select><Icon name="down" size={14} /></div></div></section>

          <div className="workflow-tabs"><button className={section === 'playground' ? 'current' : ''} onClick={() => setSection('playground')}>Try a decision</button><button className={section === 'evaluation' ? 'current' : ''} onClick={() => setSection('evaluation')}>Evaluate quality</button><span className="tab-spacer" /><span className="type-badge">choice</span><span className="type-badge">score</span><span className="type-badge">noul</span></div>

          {section === 'playground' ? <div className="playground-layout">
            <section className="panel input-panel"><div className="panel-heading"><div><span className="step-number">01</span><div><h2>Input state</h2><p>Text or structured JSON that Laya will inspect.</p></div></div><button className="text-button" onClick={() => { setStateText(JSON.stringify(examples.duplicate, null, 2)); setResult(null) }}>Reset</button></div>
              <div className="sample-row"><span>Try a sample</span><button onClick={() => loadExample('duplicate')}>Duplicate charge</button><button onClick={() => loadExample('outage')}>Product outage</button><button onClick={() => loadExample('sales')}>Pricing question</button></div>
              <label className="field-label" htmlFor="state-json">STATE <span>JSON object</span></label><textarea id="state-json" className={`code-editor ${stateValidation ? 'invalid' : ''}`} spellCheck={false} value={stateText} onChange={(event) => setStateText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void runDecision() } }} aria-describedby="state-help" />
              <div id="state-help" className={`editor-help ${stateValidation ? 'error-text' : ''}`}>{stateValidation || 'The model receives this state and the questions below.'}</div>
              <div className="question-heading"><div><span className="step-number">02</span><div><h2>Questions</h2><p>Four typed decisions, evaluated together.</p></div></div><span className="forward-pass"><span /> 1 forward pass</span></div>
              <div className="question-list">{Object.entries(triageQuestions).map(([id, question]) => <article key={id} className="question-row"><span className={`question-type ${question.type}`}>{question.type === 'choice' ? 'C' : question.type === 'score' ? 'S' : 'N'}</span><div className="question-copy"><strong>{id.replace('_', ' ')}</strong><p>{question.instructions}</p></div><span className="type-label">{question.type}</span></article>)}</div>
              <button className="run-button" onClick={runDecision} disabled={busy || Boolean(stateValidation)}><Icon name="play" size={15} />{busy ? 'Running Laya…' : 'Run decision'}<span>Ctrl ↵</span></button>
            </section>

            <section className="panel results-panel"><div className="panel-heading result-heading"><div><span className="step-number">03</span><div><h2>Decision output</h2><p>Typed answers with model confidence.</p></div></div>{result && <span className="result-ok"><Icon name="check" size={13} /> Complete</span>}</div>
              {!result && !busy && !error && <div className="results-empty"><div className="empty-orb"><Icon name="spark" size={23} /></div><h3>Your results will appear here</h3><p>Run the sample to see Laya return a queue, urgency level, and risk probabilities.</p><div className="empty-mini"><span>state</span><b>+</b><span>typed questions</span><b>→</b><span className="mini-output">decisions</span></div></div>}
              {busy && <div className="loading-state"><div className="loading-spinner" /><strong>Loading checkpoint and running inference</strong><p>The first run may take a little while as Laya downloads its weights.</p></div>}
              {error && <div className="error-card"><strong>{error.includes('not installed') || error.includes('not connected') ? 'Local Laya service unavailable' : 'Could not run this request'}</strong><p>{error}</p>{!serviceOnline && <span>Start the Python backend as described in README.md, then retry.</span>}</div>}
              {result && <><div className="route-card"><div><span className="route-caption">ROUTED CHECKPOINT</span><strong>{String(routingModel ?? (model === 'auto' ? 'unknown' : model))}</strong></div><span className="route-reason">{String(result.routing?.reason ?? 'Selected for this request')}</span></div>
                <div className="answer-list">{Object.entries(triageQuestions).map(([id, question]) => <AnswerCard key={id} id={id} question={question} answer={answers[id] ?? {}} />)}</div>
                <div className="result-meta"><span>Model call complete</span>{latency !== undefined && <span>{String(latency)} ms</span>}</div>
                <button className="raw-toggle" onClick={() => setRawOpen((open) => !open)}><Icon name="code" size={14} />{rawOpen ? 'Hide' : 'Inspect'} raw response <Icon name="down" size={13} /></button>
                {rawOpen && <pre className="raw-json">{JSON.stringify(result, null, 2)}</pre>}
              </>}
              {!serviceOnline && !error && <div className="inline-notice">The API server is offline. Start the local Python backend to run real inference.</div>}
            </section>
          </div> : <div className="evaluation-layout">
            <section className="panel eval-input-panel"><div className="panel-heading"><div><span className="step-number">01</span><div><h2>Evaluation set</h2><p>Each row needs input text and a gold label.</p></div></div><button className="text-button" onClick={() => { setEvaluationText(JSON.stringify(sampleEvaluation, null, 2)); setEvaluation(null) }}>Load sample</button></div>
              <div className="eval-schema"><span className="field-label">TASK RUBRIC</span><p>Which team should handle this customer request?</p><div className="rubric-labels">{Object.keys(evalCriteria).map((label) => <span key={label}>{label}</span>)}</div></div>
              <label className="field-label" htmlFor="eval-json">LABELED EXAMPLES <span>JSON array · {Object.keys(evalCriteria).length} labels</span></label><textarea id="eval-json" className="code-editor eval-editor" spellCheck={false} value={evaluationText} onChange={(event) => setEvaluationText(event.target.value)} />
              <div className="threshold-control"><div><label htmlFor="threshold">Automatic decision threshold</label><p>Below this confidence, send the case for human review.</p></div><div className="threshold-value"><input id="threshold" type="range" min="0.5" max="0.95" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><strong>{Math.round(threshold * 100)}%</strong></div></div>
              <button className="run-button" onClick={runEvaluation} disabled={busy}><Icon name="play" size={15} />{busy ? 'Evaluating…' : 'Run evaluation'}<span>{'≤ 64 rows'}</span></button>
            </section>
            <section className="panel eval-results-panel"><div className="panel-heading"><div><span className="step-number">02</span><div><h2>Evaluation report</h2><p>Accuracy and confidence-gated coverage.</p></div></div></div>
              {!evaluation && !busy && !error && <div className="results-empty eval-empty"><div className="empty-orb"><Icon name="chart" size={23} /></div><h3>Start with a labeled sample</h3><p>Run evaluation to see accuracy, automated coverage, selective accuracy, and a confusion matrix.</p><div className="eval-checks"><span><Icon name="check" size={13} /> Label quality</span><span><Icon name="check" size={13} /> Confidence threshold</span><span><Icon name="check" size={13} /> Confusion matrix</span></div></div>}
              {busy && <div className="loading-state"><div className="loading-spinner" /><strong>Scoring labeled examples</strong><p>Predictions are batched through the selected Laya checkpoint.</p></div>}
              {evaluation && <EvaluationReport report={evaluation} />}
              {error && <div className="error-card"><strong>Evaluation could not run</strong><p>{error}</p></div>}
              <div className="eval-caveat"><strong>POC note</strong><span>A tiny sample is a wiring check, not evidence of production quality. Keep a separate held-out set and evaluate each important slice.</span></div>
            </section>
          </div>}

          <footer className="page-foot"><span>Laya is a decision model, not a text generator.</span><span>Predictions are signals — apply your own policy before taking action.</span></footer>
        </div>
      </main>
    </div>
  )
}

function AnswerCard({ id, question, answer }: { id: string; question: Question; answer: Record<string, unknown> }) {
  const probabilities = (answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}) as Record<string, number>
  const confidenceValue = answer.answer_confidence ?? answer.confidence
  const confidence = typeof confidenceValue === 'number' ? confidenceValue : question.type === 'noul' && typeof answer.noul === 'number' ? Math.max(answer.noul, 1 - answer.noul) : null
  const selected = question.type === 'choice' ? answer.choice : question.type === 'score' ? answer.score : null
  const scoreLabels = Array.isArray(question.criteria) ? question.criteria : []

  return <article className="answer-card"><div className="answer-top"><div><span className={`type-chip ${question.type}`}>{question.type}</span><h3>{id.replace('_', ' ')}</h3></div>{confidence !== null && <span className="confidence-pill">{Math.round(confidence * 100)}% confidence</span>}</div>
    {question.type === 'choice' && <><div className="answer-value">{String(selected ?? '—')}</div><ProbabilityBars probabilities={probabilities} /></>}
    {question.type === 'score' && <><div className="answer-value score-value">{typeof selected === 'number' ? selected.toFixed(2) : String(selected ?? '—')}<span> expected score</span></div><div className="score-scale">{scoreLabels.map((label, index) => <div key={label} className="score-level"><span className={`score-dot ${typeof selected === 'number' && Math.round(selected) === index ? 'picked' : ''}`} /><span>{label}</span></div>)}</div></>}
    {question.type === 'noul' && <><div className="answer-value probability-value">{typeof answer.noul === 'number' ? `${Math.round(answer.noul * 100)}%` : '—'}<span> probability true</span></div><div className="probability-track"><span style={{ width: `${Math.max(0, Math.min(100, Number(answer.noul ?? 0) * 100))}%` }} /></div></>}
  </article>
}

function ProbabilityBars({ probabilities }: { probabilities: Record<string, number> }) {
  const entries = Object.entries(probabilities).filter(([, value]) => typeof value === 'number').sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  return <div className="probability-list">{entries.map(([label, value]) => <div className="probability-row" key={label}><span>{label}</span><div className="probability-track"><span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div><b>{Math.round(value * 100)}%</b></div>)}</div>
}

function EvaluationReport({ report }: { report: Evaluation }) {
  return <div className="report-content"><div className="metric-grid"><Metric label="Accuracy" value={`${Math.round(report.accuracy * 100)}%`} detail={`${report.rows.filter((row) => row.correct).length} / ${report.count} correct`} /><Metric label="ECE · 10 bins" value={`${Math.round(report.ece * 100)}%`} detail="lower is better" /><Metric label="Auto coverage" value={`${Math.round(report.coverage * 100)}%`} detail={`threshold ${Math.round(report.threshold * 100)}%`} /><Metric label="Selective accuracy" value={report.selective_accuracy === null ? '—' : `${Math.round(report.selective_accuracy * 100)}%`} detail="on auto-routed cases" /></div>
    <div className="matrix-wrap"><div className="matrix-title"><h3>Confusion matrix</h3><span>rows = expected · columns = predicted</span></div><div className="matrix-scroll"><table className="matrix-table"><thead><tr><th>Expected</th>{Object.keys(report.confusion_matrix).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{Object.entries(report.confusion_matrix).map(([expected, values]) => <tr key={expected}><th>{expected}</th>{Object.values(report.confusion_matrix).length > 0 && Object.keys(report.confusion_matrix).map((predicted) => <td key={predicted} className={expected === predicted ? 'diagonal' : ''}>{values[predicted] ?? 0}</td>)}</tr>)}</tbody></table></div></div>
    <div className="sample-results"><h3>Per-example results <span>{report.count} rows</span></h3>{report.rows.map((row, index) => <div className="eval-row" key={`${index}-${row.text}`}><span className={`row-status ${row.correct ? 'correct' : 'incorrect'}`}>{row.correct ? '✓' : '×'}</span><div className="eval-row-copy"><p>{row.text}</p><span>expected <b>{row.expected}</b> · predicted <b>{row.prediction ?? '—'}</b></span></div><span className="row-confidence">{Math.round(row.confidence * 100)}%</span></div>)}</div>
  </div>
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }

export default App
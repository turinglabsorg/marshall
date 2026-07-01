import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const css = `
:root {
  --bg: #020403;
  --panel: #070b08;
  --panel-2: #0a120d;
  --panel-3: #0d1911;
  --line: rgba(68, 255, 139, 0.24);
  --line-strong: rgba(68, 255, 139, 0.44);
  --text: #ddffe6;
  --muted: #7fa989;
  --dim: #4c6d55;
  --green: #33ff88;
  --green-soft: rgba(51, 255, 136, 0.11);
  --cyan: #66d9ef;
  --amber: #ffd166;
  --red: #ff5f6d;
  --mono: "Berkeley Mono", "JetBrains Mono", "SFMono-Regular", "IBM Plex Mono", "Fira Code", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  min-height: 100vh;
  background:
    repeating-linear-gradient(0deg, rgba(51, 255, 136, 0.035) 0, rgba(51, 255, 136, 0.035) 1px, transparent 1px, transparent 5px),
    linear-gradient(180deg, #020403 0%, #030804 48%, #010201 100%);
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.45;
}
a { color: inherit; }
button, select { font: inherit; }
.shell { min-height: 100vh; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 58px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(2, 4, 3, 0.92);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  background: var(--panel-2);
  color: var(--green);
  box-shadow: inset 0 0 18px rgba(51, 255, 136, 0.12), 0 0 22px rgba(51, 255, 136, 0.08);
}
.mark::before { content: ">_"; font-size: 13px; font-weight: 700; }
.brand h1 { margin: 0; color: var(--green); font-size: 16px; font-weight: 700; text-transform: lowercase; }
.brand span { display: block; color: var(--muted); font-size: 11px; white-space: nowrap; }
.topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.sync-control, .status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.sync-control select {
  min-height: 22px;
  border: 1px solid var(--line);
  background: #020403;
  color: var(--green);
}
.status { color: var(--text); font-size: 12px; padding: 0 11px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 12px currentColor; }
.dot.ok { background: var(--green); }
.dot.bad { background: var(--red); }
main { width: min(1520px, 100%); margin: 0 auto; padding: 18px; }
.terminal-head {
  display: grid;
  gap: 1px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  background: var(--line);
  box-shadow: 0 0 0 1px rgba(51, 255, 136, 0.04), 0 28px 70px rgba(0, 0, 0, 0.38);
}
.prompt-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 12px;
  overflow-x: auto;
  overflow-y: hidden;
  background: #030704;
  color: var(--text);
  white-space: nowrap;
}
.prompt-user, .prompt-symbol { color: var(--green); }
.prompt-path { color: var(--cyan); }
.cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  margin-left: 2px;
  background: var(--green);
  box-shadow: 0 0 14px rgba(51, 255, 136, 0.55);
  animation: blink 1.1s steps(2, start) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
.boot-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 0.72fr); gap: 1px; background: var(--line); }
.statement, .join-panel { min-width: 0; background: rgba(7, 11, 8, 0.96); }
.statement { padding: 18px; }
.statement h2 {
  max-width: 860px;
  margin: 0 0 10px;
  color: var(--text);
  font-size: clamp(26px, 3.8vw, 52px);
  font-weight: 700;
  line-height: 1.02;
  text-transform: uppercase;
}
.statement p { max-width: 820px; margin: 0; color: var(--muted); font-size: 13px; }
.kicker { margin: 0 0 12px; color: var(--green); font-size: 12px; }
.kicker::before { content: "[ok] "; color: var(--green); }
.join-panel { display: grid; gap: 12px; align-content: start; padding: 14px; }
.join-panel h3, .section h3 { margin: 0; color: var(--green); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.join-panel p { margin: 0; color: var(--muted); }
.command {
  display: block;
  overflow: auto;
  max-width: 100%;
  padding: 12px;
  border: 1px solid var(--line);
  background: #020403;
  color: var(--text);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre;
}
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.button, .inline-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  background: var(--green-soft);
  color: var(--green);
  text-decoration: none;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.button::before { content: "$ "; color: var(--muted); }
.button.secondary { color: var(--text); background: rgba(221, 255, 230, 0.04); }
.inline-control { min-height: 28px; padding: 0 9px; background: #020403; font-size: 11px; }
.inline-control:disabled { color: var(--dim); cursor: not-allowed; }
.summary-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.contract-panel, .progress-panel {
  display: grid;
  gap: 1px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  background: var(--line);
  box-shadow: inset 0 0 30px rgba(51, 255, 136, 0.035);
}
.contract-panel { grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.6fr); }
.contract-main, .contract-side, .progress-total, .progress-phases { min-width: 0; background: var(--panel); }
.contract-main { padding: 14px; }
.contract-side { display: grid; grid-template-columns: 1fr 1fr; }
.contract-side .metric { min-height: 84px; border-width: 0 0 1px 1px; box-shadow: none; }
.contract-label, .progress-label { color: var(--green); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.contract-title {
  margin: 8px 0 12px;
  color: var(--text);
  font-size: clamp(20px, 2.8vw, 38px);
  font-weight: 700;
  line-height: 1.05;
  overflow-wrap: anywhere;
}
.contract-meta, .run-counts { display: flex; flex-wrap: wrap; gap: 8px; }
.metric {
  min-height: 92px;
  padding: 13px;
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: inset 0 0 24px rgba(51, 255, 136, 0.04);
}
.metric strong {
  display: block;
  margin-top: 10px;
  color: var(--green);
  font-size: clamp(30px, 4vw, 46px);
  font-weight: 700;
  line-height: 0.9;
  overflow-wrap: anywhere;
  text-shadow: 0 0 20px rgba(51, 255, 136, 0.18);
}
#clusterThroughput { font-size: clamp(18px, 2.2vw, 30px); line-height: 1.05; }
.metric span { display: block; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.runs-panel { margin-bottom: 14px; }
.run-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 10px; background: #030704; }
.run-list.past { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.run-lane, .past-run-lane { min-width: 0; padding: 13px; background: var(--panel); }
.run-lane.primary { background: var(--panel-2); box-shadow: inset 0 0 28px rgba(51, 255, 136, 0.065); }
.past-run-lane { padding: 11px; background: #050806; }
.run-title { display: flex; justify-content: space-between; gap: 10px; color: var(--green); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.run-title span { color: var(--muted); font-size: 11px; text-transform: none; text-align: right; }
.run-model { margin-top: 8px; color: var(--text); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
.past-run-lane .run-model { font-size: 12px; }
.run-meta { margin-top: 8px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.run-counts { margin-top: 10px; gap: 6px; }
.progress-panel { grid-template-columns: minmax(240px, 0.36fr) minmax(0, 1fr); }
.progress-total { padding: 14px; }
.progress-label { color: var(--muted); font-size: 11px; }
.progress-value {
  margin-top: 8px;
  color: var(--green);
  font-size: clamp(46px, 8vw, 76px);
  font-weight: 700;
  line-height: 0.9;
  text-shadow: 0 0 24px rgba(51, 255, 136, 0.2);
}
.progress-detail { margin-top: 10px; color: var(--muted); font-size: 12px; }
.progress-track, .phase-track {
  height: 9px;
  margin-top: 13px;
  border: 1px solid var(--line);
  background: #020403;
  overflow: hidden;
}
.progress-fill, .phase-fill {
  width: 0%;
  height: 100%;
  background: linear-gradient(90deg, rgba(51, 255, 136, 0.4), var(--green));
  box-shadow: 0 0 18px rgba(51, 255, 136, 0.35);
  transition: width 320ms ease;
}
.progress-phases { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.phase { display: grid; align-content: start; min-height: 112px; padding: 13px; border-left: 1px solid var(--line); }
.phase:first-child { border-left: 0; }
.phase-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--green); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.phase-percent { color: var(--text); }
.phase-counts { margin-top: 9px; color: var(--muted); font-size: 12px; }
.phase-track { height: 6px; margin-top: 11px; }
.phase-fill { background: var(--green); box-shadow: none; }
.phase.empty .phase-head, .phase.empty .phase-counts { color: var(--dim); }
.phase.empty .phase-fill { background: var(--dim); }
.live-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
.grid.vertical { display: grid; grid-template-columns: 1fr; gap: 14px; }
.section {
  min-width: 0;
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: inset 0 0 30px rgba(51, 255, 136, 0.035);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  padding: 0 13px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}
.section-header h3::before { content: "./"; color: var(--muted); }
.section-header span { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; text-align: right; }
.pager { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
.table-wrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 10px 12px; border-bottom: 1px solid rgba(68, 255, 139, 0.12); text-align: left; vertical-align: top; }
th { color: var(--dim); font-size: 11px; font-weight: 700; text-transform: uppercase; }
td { color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
td strong { color: var(--text); font-weight: 700; }
td span { color: var(--muted); }
tr:hover td { background: rgba(51, 255, 136, 0.045); }
.run-divider td { background: #030704; color: var(--green); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.run-divider span { color: var(--muted); font-weight: 400; text-transform: none; }
.run-divider:hover td { background: #030704; }
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 7px;
  border: 1px solid var(--line);
  background: rgba(221, 255, 230, 0.04);
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.pill.running { color: var(--cyan); border-color: rgba(102, 217, 239, 0.48); background: rgba(102, 217, 239, 0.09); }
.pill.completed { color: var(--green); border-color: rgba(51, 255, 136, 0.5); background: var(--green-soft); }
.pill.failed { color: var(--red); border-color: rgba(255, 95, 109, 0.55); background: rgba(255, 95, 109, 0.1); }
.pill.queued { color: var(--amber); border-color: rgba(255, 209, 102, 0.48); background: rgba(255, 209, 102, 0.09); }
.pill.idle { color: var(--muted); }
.event-log { display: grid; gap: 1px; max-height: 560px; overflow: auto; background: rgba(68, 255, 139, 0.12); }
.event { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 10px 12px; background: var(--panel); }
.event time { color: var(--dim); font-size: 11px; }
.event strong { display: block; color: var(--green); font-size: 12px; overflow-wrap: anywhere; }
.event span { display: block; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.empty { padding: 24px 16px; color: var(--muted); }
@media (max-width: 1080px) {
  .boot-grid, .contract-panel, .progress-panel, .live-grid, .grid.vertical { grid-template-columns: 1fr; }
  .contract-side, .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .progress-phases, .run-list, .run-list.past { grid-template-columns: 1fr; }
  .phase { border-top: 1px solid var(--line); border-left: 0; }
}
@media (max-width: 640px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .topbar-actions { justify-content: flex-start; }
  main { padding: 12px; }
  .summary-grid, .contract-side { grid-template-columns: 1fr; }
  .statement h2 { font-size: 30px; }
  .event { grid-template-columns: 1fr; }
}
`;

injectStyles(css);

function App() {
  const [dashboard, setDashboard] = useState(null);
  const [health, setHealth] = useState({ ok: false, text: "connecting" });
  const [events, setEvents] = useState(new Map());
  const [syncIntervalMs, setSyncIntervalMs] = useState(5000);
  const [showHistory, setShowHistory] = useState(false);
  const [jobPage, setJobPage] = useState(1);
  const [streamText, setStreamText] = useState("opening stream");

  const refreshDashboard = async () => {
    try {
      const [healthResponse, dashboardResponse] = await Promise.all([
        fetch("/health", { cache: "no-store" }),
        fetch("/dashboard", { cache: "no-store" }),
      ]);
      if (!healthResponse.ok || !dashboardResponse.ok) {
        throw new Error("coordinator unavailable");
      }
      const nextDashboard = await dashboardResponse.json();
      setDashboard(nextDashboard);
      setEvents((current) => {
        const next = new Map(current);
        for (const event of nextDashboard.recent_events || []) {
          next.set(event.id, event);
        }
        return trimEventMap(next, 160);
      });
      setHealth({ ok: true, text: "coordinator online" });
    } catch {
      setHealth({ ok: false, text: "coordinator offline" });
    }
  };

  useEffect(() => {
    void refreshDashboard();
  }, []);

  useEffect(() => {
    if (syncIntervalMs <= 0) {
      return undefined;
    }
    const timer = setInterval(() => void refreshDashboard(), syncIntervalMs);
    return () => clearInterval(timer);
  }, [syncIntervalMs]);

  useEffect(() => {
    if (!("EventSource" in window)) {
      setStreamText("polling");
      return undefined;
    }
    const source = new EventSource("/events/stream");
    let refreshTimer = null;
    source.addEventListener("open", () => setStreamText("live"));
    source.addEventListener("marshall_event", (message) => {
      const event = JSON.parse(message.data);
      setEvents((current) => {
        const next = new Map(current);
        next.set(event.id, event);
        return trimEventMap(next, 160);
      });
      if (refreshTimer == null) {
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refreshDashboard();
        }, 600);
      }
    });
    source.addEventListener("error", () => setStreamText("reconnecting"));
    return () => {
      if (refreshTimer != null) {
        clearTimeout(refreshTimer);
      }
      source.close();
    };
  }, []);

  const summary = dashboard?.summary || {};
  const runs = useMemo(() => summarizeRuns(dashboard?.jobs || []), [dashboard]);
  const selectedRun = useMemo(() => runs.find(runIsActive) || null, [runs]);
  const pastRuns = runs.filter((run) => !runIsActive(run));

  const toggleHistory = () => {
    setShowHistory((value) => !value);
    setJobPage(1);
  };

  return (
    <div className="shell">
      <Topbar health={health} syncIntervalMs={syncIntervalMs} setSyncIntervalMs={setSyncIntervalMs} />
      <main>
        <Hero />
        <TrainingContract selectedRun={selectedRun} />
        <SummaryGrid summary={summary} />
        <ActiveRuns runs={runs.filter(runIsActive)} selectedRun={selectedRun} />
        <ProgressPanel jobs={dashboard?.jobs || []} selectedRun={selectedRun} />
        <PastRuns runs={pastRuns} showHistory={showHistory} toggleHistory={toggleHistory} />
        <LiveGrid dashboard={dashboard} summary={summary} events={events} streamText={streamText} />
        <JobsTable runs={runs} showHistory={showHistory} page={jobPage} setPage={setJobPage} />
        <ArtifactsTable artifacts={dashboard?.artifacts || []} />
      </main>
    </div>
  );
}

function Topbar({ health, syncIntervalMs, setSyncIntervalMs }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark" aria-hidden="true" />
        <div>
          <h1>marshall</h1>
          <span>coordinator tty / live swarm</span>
        </div>
      </div>
      <div className="topbar-actions">
        <label className="sync-control">auto sync
          <select value={syncIntervalMs} onChange={(event) => setSyncIntervalMs(Number(event.target.value))}>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
            <option value={30000}>30s</option>
            <option value={0}>off</option>
          </select>
        </label>
        <div className="status"><span className={`dot ${health.ok ? "ok" : "bad"}`} /><span>{health.text}</span></div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="terminal-head">
      <div className="prompt-line">
        <span className="prompt-user">marshall@swarm</span><span className="prompt-path">:~/coordinator</span><span className="prompt-symbol">$</span><span>./marshall status --live</span><span className="cursor" aria-hidden="true" />
      </div>
      <div className="boot-grid">
        <div className="statement">
          <p className="kicker">control plane online</p>
          <h2>permissionless distributed training network</h2>
          <p>Marshall coordinates open Mac workers that claim real dataset shards, verify hashes locally, train LoRA adapters, and publish artifacts back to the swarm.</p>
        </div>
        <aside className="join-panel">
          <h3>worker bootstrap</h3>
          <p>No join token. Fetch the live control address, start a worker, and let your Mac claim the next compatible job.</p>
          <code className="command">{`npm run worker:pool:compiled -- \\
  --control "$MARSHALL_CONTROL_ADDR" \\
  --job-type train_adapter \\
  --backend mlx \\
  --concurrency 1 \\
  --max-jobs 1`}</code>
          <div className="actions">
            <a className="button" href="/AGENTS.md">open AGENTS.md</a>
            <a className="button secondary" href="https://github.com/turinglabsorg/marshall" rel="noreferrer">git clone</a>
            <a className="button secondary" href="/dashboard">cat /dashboard.json</a>
          </div>
        </aside>
      </div>
    </section>
  );
}

function TrainingContract({ selectedRun }) {
  if (!selectedRun) {
    return (
      <section className="contract-panel" aria-label="Current training contract">
        <div className="contract-main">
          <div className="contract-label">active training contract</div>
          <div className="contract-title">Waiting for coordinator jobs</div>
          <div className="contract-meta"><Pill className="idle">waiting</Pill></div>
        </div>
        <div className="contract-side">
          <Metric label="dataset.shards" value="0" />
          <Metric label="jobs.queued" value="0" />
          <Metric label="adapter.iters" value="0" />
          <Metric label="lora.layers" value="0" />
        </div>
      </section>
    );
  }
  const config = selectedRun.trainingConfig || {};
  const queued = selectedRun.jobs.filter((entry) => ((entry.job || {}).status || "queued") === "queued").length;
  return (
    <section className="contract-panel" aria-label="Current training contract">
      <div className="contract-main">
        <div className="contract-label">{selectedRun.phaseLabel} / {selectedRun.statusLabel}</div>
        <div className="contract-title">{selectedRun.model || "model unset"} :: {selectedRun.dataset || "dataset unset"}</div>
        <div className="contract-meta">
          <Pill className="running">run {selectedRun.key || "unknown"}</Pill>
          <Pill>dataset {selectedRun.datasetVersion || "unversioned"}</Pill>
          <Pill>jobs {selectedRun.jobs.length}</Pill>
          <Pill>seq {config.max_seq_length || "?"}</Pill>
          <Pill>lr {config.learning_rate || "?"}</Pill>
          <Pill>ram {selectedRun.minMemoryGb || "?"}GB</Pill>
        </div>
      </div>
      <div className="contract-side">
        <Metric label="dataset.shards" value={selectedRun.counts.train.total || selectedRun.jobs.length} />
        <Metric label="jobs.queued" value={queued} />
        <Metric label="adapter.iters" value={config.iters || 0} />
        <Metric label="lora.layers" value={config.num_layers || 0} />
      </div>
    </section>
  );
}

function SummaryGrid({ summary }) {
  return (
    <section className="summary-grid" aria-label="Swarm summary">
      <Metric label="workers.recent" value={summary.workers_registered ?? 0} />
      <Metric label="workers.busy" value={summary.workers_busy ?? 0} />
      <Metric label="jobs.running" value={summary.jobs_running ?? 0} />
      <Metric label="jobs.completed" value={summary.jobs_completed ?? 0} />
      <Metric label="artifacts.published" value={summary.artifacts_published ?? 0} />
      <Metric label="cluster.speed" value={throughputSummary(summary)} id="clusterThroughput" />
    </section>
  );
}

function Metric({ label, value, id }) {
  return <div className="metric"><span>{label}</span><strong id={id}>{value}</strong></div>;
}

function ActiveRuns({ runs, selectedRun }) {
  return (
    <section className="section runs-panel" aria-label="Published runs">
      <div className="section-header">
        <h3>active runs</h3>
        <span>grouped by base model</span>
      </div>
      <div className="run-list">
        {runs.length === 0 ? <div className="empty">No active runs.</div> : runs.slice(0, 6).map((run) => (
          <RunLane key={run.key} run={run} primary={selectedRun?.key === run.key} />
        ))}
      </div>
    </section>
  );
}

function PastRuns({ runs, showHistory, toggleHistory }) {
  return (
    <section className="section runs-panel" aria-label="Past runs">
      <div className="section-header">
        <h3>past runs</h3>
        <button className="inline-control" type="button" onClick={toggleHistory}>
          {showHistory ? "hide history" : `show history (${runs.length})`}
        </button>
      </div>
      {showHistory && (
        <div className="run-list past">
          {runs.length === 0 ? <div className="empty">No completed runs yet.</div> : runs.slice(0, 12).map((run) => (
            <PastRunLane key={run.key} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunLane({ run, primary = false }) {
  return (
    <article className={`run-lane ${primary ? "primary" : ""}`}>
      <div className="run-title">{run.shortName}<span>{run.statusLabel}</span></div>
      <div className="run-model">{run.model || "model unset"}</div>
      <div className="run-meta">{run.dataset || "dataset unset"} · {run.key}</div>
      <div className="run-counts">
        <Pill className={countStatus(run.counts.train)}>train {run.counts.train.completed}/{run.counts.train.total}</Pill>
        <Pill className={countStatus(run.counts.eval)}>eval {run.counts.eval.completed}/{run.counts.eval.total}</Pill>
        <Pill className={countStatus(run.counts.validation)}>val {run.counts.validation.completed}/{run.counts.validation.total}</Pill>
        <Pill>ram {run.minMemoryGb || "?"}GB</Pill>
      </div>
    </article>
  );
}

function PastRunLane({ run }) {
  const terminal = run.jobs.filter((entry) => isTerminalStatus((entry.job || {}).status)).length;
  const failed = run.jobs.filter((entry) => (entry.job || {}).status === "failed").length;
  return (
    <article className="past-run-lane">
      <div className="run-title">{run.shortName}<span>{timeLabel(new Date(run.latestTime).toISOString())}</span></div>
      <div className="run-model">{run.model || "model unset"}</div>
      <div className="run-meta">{run.dataset || "dataset unset"} · {run.key}</div>
      <div className="run-counts">
        <Pill className={failed > 0 ? "failed" : "completed"}>{terminal}/{run.jobs.length} terminal</Pill>
        {failed > 0 ? <Pill className="failed">{failed} failed</Pill> : <Pill className="completed">clean</Pill>}
        <Pill>ram {run.minMemoryGb || "?"}GB</Pill>
      </div>
    </article>
  );
}

function ProgressPanel({ jobs, selectedRun }) {
  const scopedJobs = selectedRun
    ? jobs.filter((entry) => canonicalRunId((entry.job || {}).run_id || "") === selectedRun.key)
    : [];
  const phases = [
    phaseProgress(scopedJobs, "train_adapter", "training"),
    phaseProgress(scopedJobs, "evaluate_adapter", "evaluation"),
    phaseProgress(scopedJobs, "validate_artifact", "validation"),
  ];
  const totals = phases.reduce((total, phase) => ({
    total: total.total + phase.total,
    terminal: total.terminal + phase.terminal,
    remaining: total.remaining + phase.remaining,
  }), { total: 0, terminal: 0, remaining: 0 });
  const percent = percentValue(totals.terminal, totals.total);
  return (
    <section className="progress-panel" aria-label="End-to-end work completion">
      <div className="progress-total">
        <div className="progress-label">{selectedRun ? `${selectedRun.shortName} completion` : "active run completion"}</div>
        <div className="progress-value">{totals.total === 0 ? "0%" : `${percent}%`}</div>
        <div className="progress-detail">{totals.total === 0 ? "no active run jobs" : `${totals.terminal} / ${totals.total} terminal jobs · ${totals.remaining} remaining`}</div>
        <div className="progress-track" aria-hidden="true"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
      </div>
      <div className="progress-phases">
        {phases.map((phase) => <PhaseProgress key={phase.label} phase={phase} />)}
      </div>
    </section>
  );
}

function PhaseProgress({ phase }) {
  const percent = percentValue(phase.terminal, phase.total);
  return (
    <div className={`phase ${phase.total === 0 ? "empty" : ""}`}>
      <div className="phase-head"><span>{phase.label}</span><span className="phase-percent">{phase.total === 0 ? "--" : `${percent}%`}</span></div>
      <div className="phase-counts">
        {phase.total === 0 ? "not scheduled" : `${phase.terminal}/${phase.total} terminal · ${phase.remaining} left`}
        {phase.total > 0 && <><br /><span>{phase.running} active · {phase.failed} failed</span></>}
      </div>
      <div className="phase-track" aria-hidden="true"><div className="phase-fill" style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function LiveGrid({ dashboard, summary, events, streamText }) {
  return (
    <section className="live-grid" aria-label="Live worker activity">
      <WorkersPanel workers={dashboard?.workers || []} summary={summary} generatedAt={dashboard?.generated_at} />
      <EventStream events={events} streamText={streamText} />
    </section>
  );
}

function WorkersPanel({ workers, summary, generatedAt }) {
  const clusterThroughput = Number(summary.cluster_throughput_units_per_second || 0);
  return (
    <div className="section">
      <div className="section-header">
        <h3>workers</h3>
        <span>{generatedAt ? `updated ${timeLabel(generatedAt)}` : "waiting for data"}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th style={{ width: "28%" }}>worker</th><th style={{ width: "18%" }}>backend</th><th style={{ width: "20%" }}>state</th><th style={{ width: "34%" }}>output</th></tr>
          </thead>
          <tbody>
            {workers.length === 0 ? <tr><td colSpan="4" className="empty">No recent workers.</td></tr> : workers.map((activity, index) => {
              const worker = activity.worker || {};
              const status = activity.busy ? "running" : (activity.last_status || "registered");
              const output = activity.last_artifact_hash
                ? `${activity.last_artifact_type || "artifact"} ${shortHash(activity.last_artifact_hash)}`
                : activity.last_event_type || "registered";
              const peerLabel = worker.peer_id ? shortPeerId(worker.peer_id) : shortHash(worker.worker_id || "");
              return (
                <tr key={`${worker.worker_id || "worker"}-${index}`}>
                  <td><strong title={worker.peer_id || worker.worker_id || ""}>{peerLabel}</strong><br /><span title={worker.worker_id || ""}>{shortWorkerLabel(worker.worker_id || "")}</span></td>
                  <td>{worker.backend || "unknown"}<br /><span>{worker.device_family || ""}</span></td>
                  <td><span className={`pill ${statusClass(status)}`}>{status}</span>{reputationLabel(worker)}<br /><span>{timeLabel(activity.last_seen_at)}</span></td>
                  <td>{output}{activity.current_job_id ? <><br /><span>{activity.current_job_id}</span></> : null}{progressMarkup(worker)}{throughputMarkup(worker, clusterThroughput)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EventStream({ events, streamText }) {
  const visibleEvents = Array.from(events.values()).slice(-80).reverse().slice(0, 18);
  return (
    <div className="section">
      <div className="section-header">
        <h3>event stream</h3>
        <span>{streamText}</span>
      </div>
      <div className="event-log">
        {visibleEvents.length === 0 ? <div className="empty">Waiting for coordinator events.</div> : visibleEvents.map((event) => {
          const display = eventDisplay(event);
          return (
            <div className="event" key={event.id || `${display.type}-${display.createdAt}`}>
              <time>{timeLabel(display.createdAt)}</time>
              <div><strong>{display.type}</strong><span>{display.detail}</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JobsTable({ runs, showHistory, page, setPage }) {
  const rows = flattenJobRows(showHistory ? runs : runs.filter(runIsActive));
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  useEffect(() => {
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [safePage, page, setPage]);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  return (
    <section className="grid vertical">
      <div className="section">
        <div className="section-header">
          <h3>jobs</h3>
          <div className="pager">
            <button className="inline-control" type="button" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))}>prev</button>
            <span>page {safePage} / {totalPages} · {rows.length} rows</span>
            <button className="inline-control" type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>next</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th style={{ width: "32%" }}>job</th><th style={{ width: "18%" }}>type</th><th style={{ width: "16%" }}>state</th><th style={{ width: "34%" }}>worker / artifact</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan="4" className="empty">{showHistory ? "No jobs published yet." : "No active jobs. Show history to inspect completed runs."}</td></tr>
              ) : pageRows.map((row, index) => row.kind === "divider"
                ? <RunDivider key={`${row.run.key}-${index}`} run={row.run} />
                : <JobRow key={`${row.entry.job?.job_id || "job"}-${index}`} entry={row.entry} />)}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RunDivider({ run }) {
  return <tr className="run-divider"><td colSpan="4">{run.shortName} <span>{run.model || "model unset"} · {run.key}</span></td></tr>;
}

function JobRow({ entry }) {
  const job = entry.job || {};
  const artifact = entry.artifact || null;
  const detail = artifact ? `${artifact.artifact_type} ${shortHash(artifact.artifact_hash)}` : workerJobLabel(job);
  return (
    <tr>
      <td><strong>{job.job_id}</strong><br /><span>{job.run_id || ""}</span></td>
      <td>{job.job_type || ""}<br /><span>{job.backend || ""}</span></td>
      <td><span className={`pill ${statusClass(job.status)}`}>{job.status || "unknown"}</span></td>
      <td>{detail}{progressMarkup(job)}{throughputMarkup(job, 0)}</td>
    </tr>
  );
}

function ArtifactsTable({ artifacts }) {
  const latest = artifacts.slice().reverse().slice(0, 12);
  return (
    <section className="grid vertical">
      <div className="section">
        <div className="section-header">
          <h3>artifacts</h3>
          <span>worker outputs</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th style={{ width: "28%" }}>job</th><th style={{ width: "22%" }}>type</th><th style={{ width: "50%" }}>hash</th></tr>
            </thead>
            <tbody>
              {latest.length === 0 ? <tr><td colSpan="3" className="empty">No artifacts published yet.</td></tr> : latest.map((artifact) => {
                const verdict = artifact.verdict || artifact.verdict_status || "pending";
                return (
                  <tr key={`${artifact.job_id}-${artifact.artifact_hash}`}>
                    <td><strong>{artifact.job_id}</strong><br /><span>{timeLabel(artifact.created_at)}</span></td>
                    <td>{artifact.artifact_type || ""}<br /><span className={`pill ${statusClass(verdict)}`}>{verdict}</span>{artifact.verdict_quorum ? <><br /><span>{artifact.verdict_votes || 0}/{artifact.verdict_quorum} votes</span></> : null}</td>
                    <td>{artifact.artifact_hash || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Pill({ children, className = "" }) {
  return <span className={`pill ${className}`}>{children}</span>;
}

function summarizeRuns(jobs) {
  const runs = new Map();
  for (const entry of jobs) {
    const job = entry.job || {};
    const key = canonicalRunId(job.run_id || job.job_id || "unknown");
    const run = runs.get(key) || emptyRun(key);
    run.jobs.push(entry);
    run.latestTime = Math.max(run.latestTime, Date.parse(job.created_at || "") || 0);
    run.firstTime = Math.min(run.firstTime, Date.parse(job.created_at || "") || run.firstTime);
    const spec = job.job_spec || {};
    const config = spec.training_config || {};
    if (!run.trainingConfig && Object.keys(config).length > 0) {
      run.trainingConfig = config;
    }
    run.model ||= config.model || spec.model || "";
    const shard = spec.dataset_shard || spec.eval_shard || {};
    run.dataset ||= shard.dataset_id || shard.id || job.dataset_uri || "";
    run.datasetVersion ||= shard.dataset_version || "";
    run.minMemoryGb ||= (spec.resource_requirements || {}).min_memory_gb || "";
    const counts = countsForJobType(run, job.job_type);
    counts.total += 1;
    const status = job.status || "queued";
    if (status === "completed") counts.completed += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "running" || status === "claimed") counts.running += 1;
    else counts.queued += 1;
    runs.set(key, run);
  }
  const output = Array.from(runs.values());
  for (const run of output) {
    run.statusLabel = runStatusLabel(run.jobs);
    run.phaseLabel = runPhaseLabel(run);
  }
  return output.sort((left, right) => {
    const leftActive = runIsActive(left) ? 1 : 0;
    const rightActive = runIsActive(right) ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    return right.latestTime - left.latestTime;
  });
}

function emptyRun(key) {
  return {
    key,
    shortName: shortRunLabel(key),
    jobs: [],
    model: "",
    dataset: "",
    datasetVersion: "",
    trainingConfig: null,
    minMemoryGb: "",
    latestTime: 0,
    firstTime: Number.POSITIVE_INFINITY,
    statusLabel: "queued",
    phaseLabel: "run",
    counts: { train: emptyCounts(), eval: emptyCounts(), validation: emptyCounts() },
  };
}

function emptyCounts() {
  return { total: 0, queued: 0, running: 0, completed: 0, failed: 0 };
}

function countsForJobType(run, jobType) {
  if (jobType === "evaluate_adapter") return run.counts.eval;
  if (jobType === "validate_artifact") return run.counts.validation;
  return run.counts.train;
}

function countStatus(counts) {
  if (counts.failed > 0) return "failed";
  if (counts.running > 0) return "running";
  if (counts.queued > 0) return "queued";
  if (counts.completed > 0) return "completed";
  return "idle";
}

function runIsActive(run) {
  return run.jobs.some((entry) => ["queued", "claimed", "running", ""].includes((entry.job || {}).status || "queued"));
}

function runStatusLabel(jobs) {
  const statuses = jobs.map((entry) => (entry.job || {}).status || "queued");
  if (statuses.some((status) => status === "running" || status === "claimed")) return "running";
  if (statuses.some((status) => status === "queued" || status === "")) return "queued";
  if (statuses.some((status) => status === "failed")) return "completed with failures";
  return "completed";
}

function runPhaseLabel(run) {
  if (run.counts.validation.total > 0) return "validation";
  if (run.counts.eval.total > 0) return "evaluation";
  return "training";
}

function canonicalRunId(runId) {
  return String(runId || "").replace(/_validation$/, "").replace(/_eval$/, "");
}

function shortRunLabel(runId) {
  const value = canonicalRunId(runId);
  if (!value) return "run:unknown";
  const parts = value.split("_").filter(Boolean);
  const modelPart = parts.find((part) => /gemma|qwen|llama|mistral/i.test(part));
  const idPart = parts.slice(-2).join("_");
  return modelPart ? `${modelPart} ${idPart}` : shortHash(value);
}

function phaseProgress(jobs, jobType, label) {
  const phaseJobs = jobs.filter((entry) => (entry.job || {}).job_type === jobType);
  const terminal = phaseJobs.filter((entry) => isTerminalStatus((entry.job || {}).status)).length;
  return {
    label,
    total: phaseJobs.length,
    terminal,
    remaining: phaseJobs.length - terminal,
    running: phaseJobs.filter((entry) => ["running", "claimed"].includes((entry.job || {}).status)).length,
    failed: phaseJobs.filter((entry) => (entry.job || {}).status === "failed").length,
  };
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}

function percentValue(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function flattenJobRows(runs) {
  const rows = [];
  for (const run of runs) {
    rows.push({ kind: "divider", run });
    for (const entry of run.jobs.slice().reverse()) {
      rows.push({ kind: "job", entry });
    }
  }
  return rows;
}

function throughputSummary(summary) {
  const value = Number(summary.cluster_throughput_units_per_second || 0);
  if (!value) return "0";
  return `${formatNumber(value)} ${summary.cluster_throughput_label || "units/s"}`;
}

function progressMarkup(source) {
  if (source.progress_percent == null) return null;
  const percent = Math.round(Number(source.progress_percent));
  const label = source.progress_label ? ` ${source.progress_label}` : "";
  return <><br /><span>{percent}%{label}</span></>;
}

function throughputMarkup(source, clusterThroughput) {
  if (source.throughput_units_per_second == null) return null;
  const value = Number(source.throughput_units_per_second);
  const label = source.throughput_label || "units/s";
  const share = clusterThroughput > 0 ? ` · ${Math.round((value / clusterThroughput) * 100)}% cluster` : "";
  return <><br /><span>{formatNumber(value)} {label}{share}</span></>;
}

function reputationLabel(worker) {
  const reputation = worker.reputation || {};
  if (reputation.score == null || reputation.status == null) return null;
  return <><br /><span>rep {reputation.score} {reputation.status}</span></>;
}

function eventDisplay(event) {
  const fields = event.fields || {};
  const job = fields.job_id ? shortJobLabel(fields.job_id) : "";
  const worker = fields.peer_id ? shortPeerId(fields.peer_id) : shortWorkerLabel(fields.worker_id || "");
  const status = fields.status || fields.verdict || fields.artifact_type || fields.job_type || "";
  const detail = [job, worker, status].filter(Boolean).join(" ");
  return {
    type: event.type || "event",
    createdAt: fields.created_at,
    detail: detail || shortHash(event.id || "event"),
  };
}

function workerJobLabel(job) {
  if (!job.worker_id) return "unassigned";
  if (job.peer_id) return shortPeerId(job.peer_id);
  return shortWorkerLabel(job.worker_id);
}

function statusClass(status) {
  if (status === "completed" || status === "accepted") return "completed";
  if (status === "failed" || status === "rejected" || status === "malicious") return "failed";
  if (status === "running" || status === "claimed" || status === "working" || status === "poor") return "running";
  if (status === "queued" || status === "pending") return "queued";
  if (status === "idle" || status === "registered") return "idle";
  return "";
}

function shortPeerId(value) {
  if (!value) return "peer:unknown";
  return `peer:${value.slice(-8)}`;
}

function shortWorkerLabel(value) {
  if (!value) return "worker:unknown";
  const match = value.match(/(?:^|-)0*(\d+)$/);
  if (match) return `worker:${match[1].padStart(2, "0")}`;
  return shortHash(value);
}

function shortJobLabel(value) {
  if (!value) return "";
  const match = value.match(/_(\d{3,6})$/);
  if (match) return `job:${match[1]}`;
  return shortHash(value);
}

function shortHash(value) {
  if (!value) return "";
  return value.length <= 18 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function timeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function trimEventMap(map, limit) {
  if (map.size <= limit) return map;
  const entries = Array.from(map.entries()).slice(-limit);
  return new Map(entries);
}

function injectStyles(content) {
  const style = document.createElement("style");
  style.textContent = content;
  document.head.appendChild(style);
}

createRoot(document.getElementById("root")).render(<App />);

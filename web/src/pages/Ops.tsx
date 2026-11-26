import { useRef, useState } from 'react';
import { api, type OpsSummary } from '../api';
import { usePoll } from '../hooks';
import { staggerIn, useGsap } from '../motion';
import { AnalyticsPanel } from '../components/AnalyticsPanel';
import { MissedDemand } from '../components/MissedDemand';
import { ConsoleTabs } from './Customers';

/**
 * /ops: the screen that proves the three Aiven services are doing real work (doc/06 §4).
 * Everything comes from one endpoint; the API reads Kafka lag from pipeline_stats (written by the
 * monitor worker), so this page never talks to Kafka directly.
 */

const HISTORY = 40;

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 24" aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (HISTORY - 1)) * 100},${22 - (v / max) * 20}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour12: false });

export function Ops() {
  const [s, setS] = useState<OpsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const history = useRef(new Map<string, number[]>());
  const pageRef = useRef<HTMLElement>(null);
  const loaded = s !== null;
  // Tiles cascade in on first load only; the 2 s refresh just updates numbers in place.
  useGsap(() => loaded && staggerIn('.tile', { stagger: 0.05 }), [loaded], pageRef);

  usePoll(async () => {
    try {
      const r = await api<OpsSummary>('/ops/summary');
      for (const c of r.consumers) {
        const k = `${c.group}|${c.topic}`;
        const h = [...(history.current.get(k) ?? []), c.lag].slice(-HISTORY);
        history.current.set(k, h);
      }
      setS(r);
      setError(null);
      setUpdated(new Date());
    } catch (e) {
      setError((e as Error).message);
    }
  }, 2000);

  if (!s) {
    return (
      <main className="shell page">
        {error ? <div className="notice error" role="alert">API unreachable: {error}</div> : <div className="box skeleton" style={{ height: 240 }} />}
      </main>
    );
  }

  const monitor = s.workers.find((w) => w.name === 'monitor');
  const kafkaUp = Boolean(monitor?.up && s.consumers.length > 0);
  const totalLag = s.consumers.reduce((n, c) => n + c.lag, 0);
  const synced = s.index ? s.index.inSync === s.index.docs : false;

  return (
    <main className="shell page ops" ref={pageRef}>
      <ConsoleTabs />
      <div className="ops-head">
        <h1 className="page-title">Store console</h1>
        <span className={`live-pill ${error ? 'bad' : ''}`}>
          {error ? 'reconnecting…' : <>● live{updated && ` · ${updated.toLocaleTimeString('en-IN', { hour12: false })}`}</>}
        </span>
      </div>
      <p className="muted flow">
        For the retailer: what shoppers wanted that you couldn’t sell them, who was sent somewhere else, and proof that the
        stock shown online matches your stores.
      </p>

      <MissedDemand />

      <div className="ops-head an-head">
        <h2 className="an-title">
          Stock accuracy, behind the scenes{' '}
          <span className="muted small">
            checkout → PostgreSQL (order + stock + outbox, one transaction) → relay → Kafka → indexer → OpenSearch + Valkey
          </span>
        </h2>
      </div>
      <div className="ops-grid">
        <section className="tile box">
          <h2 className="tile-title">Services</h2>
          <ul className="svc">
            <li><span className={`dot ${s.services.postgres === 'up' ? '' : 'down'}`} /> PostgreSQL <b>{s.services.postgres}</b></li>
            <li><span className={`dot ${kafkaUp ? '' : 'down'}`} /> Kafka <b>{kafkaUp ? 'up' : 'no data'}</b></li>
            <li><span className={`dot ${s.services.opensearch === 'up' ? '' : 'down'}`} /> OpenSearch <b>{s.services.opensearch}</b></li>
            {s.services.valkey && s.services.valkey !== 'off' && (
              <li><span className={`dot ${s.services.valkey === 'up' ? '' : 'down'}`} /> Valkey <b>{s.services.valkey}</b> <small>live-stock cache</small></li>
            )}
          </ul>
        </section>

        <section className={`tile box ${s.outbox && s.outbox.pending > 0 ? 'warn-tile' : ''}`}>
          <h2 className="tile-title">Outbox</h2>
          <div className="big">{s.outbox?.pending ?? '—'}</div>
          <p className="muted">pending · last published #{s.outbox?.lastPublishedId ?? '—'}</p>
        </section>

        <section className={`tile box ${synced ? 'ok-tile' : 'bad-tile'}`}>
          <h2 className="tile-title">Online stock matches the database</h2>
          <div className="big">{s.index ? `${s.index.inSync} / ${s.index.docs}` : '—'}</div>
          <p>{s.index ? (synced ? 'every product × city in sync with PostgreSQL ✓' : `${s.index.drift.length} catching up`) : 'unavailable'}</p>
        </section>

        <section className="tile box">
          <h2 className="tile-title">Orders</h2>
          <div className="big">{s.orders?.total ?? '—'}</div>
          <p className="muted">{s.orders?.lastMinute ?? 0} in the last minute</p>
        </section>
      </div>

      <section className={`box tile wide ${totalLag > 0 ? 'warn-tile' : ''}`}>
        <h2 className="tile-title">Consumer groups</h2>
        <table className="lag-table">
          <thead>
            <tr><th>Group</th><th>Topic</th><th>Lag</th><th className="hide-sm">Trend</th></tr>
          </thead>
          <tbody>
            {s.consumers.length === 0 && (
              <tr><td colSpan={4} className="muted">No lag data yet. Is the monitor worker running?</td></tr>
            )}
            {s.consumers.map((c) => (
              <tr key={`${c.group}|${c.topic}`} className={c.lag > 0 ? 'lagging' : ''}>
                <td><b>{c.group}</b></td>
                <td className="mono">{c.topic}</td>
                <td className="lag">{c.lag}{c.stale && <span className="muted small"> (stale)</span>}</td>
                <td className="hide-sm"><Sparkline values={history.current.get(`${c.group}|${c.topic}`) ?? []} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="box tile wide">
        <h2 className="tile-title">Workers <span className="muted small">(heartbeat &lt; 6 s)</span></h2>
        <ul className="workers">
          {s.workers.map((w) => (
            <li key={w.name} className={w.up ? '' : 'down'}>
              <span className={`dot ${w.up ? '' : 'down'}`} /> {w.name}
              <span className="muted small">{w.lastSeenMs === null ? ' never' : w.up ? '' : ` ${Math.round(w.lastSeenMs / 1000)}s ago`}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="ops-split">
        <section className="box tile">
          <h2 className="tile-title">Live event feed</h2>
          <ol className="feed">
            {s.recentEvents.map((e) => (
              <li key={e.id}>
                <span className="mono muted">{time(e.createdAt)}</span>
                <span className={`ev ev-${e.type}`}>{e.type}</span>
                <span className="ev-sum">{e.summary}</span>
                <span className={`pub ${e.publishedAt ? '' : 'pending'}`}>{e.publishedAt ? '→ Kafka' : 'pending'}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="box tile">
          <h2 className="tile-title">Store ops <span className="muted small">(written by the notifier consumer)</span></h2>
          <ul className="feed">
            {s.stockAlerts.map((a, i) => (
              <li key={`a${i}`}><span className="ev ev-alert">Low stock</span><span className="ev-sum">{a.product} · {a.city} · {a.qty} left</span></li>
            ))}
            {s.recentNotifications.map((n, i) => (
              <li key={`n${i}`}><span className="ev ev-mail">Confirmation</span><span className="ev-sum">→ {n.to}</span></li>
            ))}
            {s.stockAlerts.length + s.recentNotifications.length === 0 && <li className="muted">Nothing yet. Place an order.</li>}
          </ul>
        </section>
      </div>

      <AnalyticsPanel />
    </main>
  );
}

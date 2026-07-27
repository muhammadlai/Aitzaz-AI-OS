import { useEffect, useState, type JSX } from 'react';

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
interface HealthReport { readonly status: HealthStatus; readonly checkedAt: string; readonly checks: Readonly<Record<string, { readonly status: HealthStatus; readonly message?: string }>>; }
interface SystemReport { readonly application: string; readonly environment: string; readonly runtime: string; readonly features: Readonly<Record<string, boolean>>; readonly services: readonly { readonly id: string; readonly tags: readonly string[]; readonly registeredAt: string }[]; }

const apiUrl = (import.meta.env.VITE_NEXUS_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:8787';
const statusStyles: Record<HealthStatus, string> = { healthy: 'bg-emerald-400', degraded: 'bg-amber-400', unhealthy: 'bg-rose-400' };

export const App = (): JSX.Element => {
  const [health, setHealth] = useState<HealthReport>();
  const [system, setSystem] = useState<SystemReport>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const [healthResponse, systemResponse] = await Promise.all([fetch(`${apiUrl}/health`, { signal: controller.signal }), fetch(`${apiUrl}/v1/system`, { signal: controller.signal })]);
        if (!healthResponse.ok || !systemResponse.ok) throw new Error('Nexus control plane is unavailable');
        setHealth(await healthResponse.json() as HealthReport);
        setSystem(await systemResponse.json() as SystemReport);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load Nexus status'); }
    };
    void load();
    return () => controller.abort();
  }, []);

  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100 sm:px-10">
    <section className="mx-auto max-w-6xl">
      <header className="mb-10 flex flex-col gap-3 border-b border-slate-800 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="mb-2 text-sm font-semibold uppercase tracking-[0.24em] text-nexus-500">Control Plane</p><h1 className="text-4xl font-bold tracking-tight">Nexus AI OS</h1><p className="mt-2 max-w-xl text-slate-400">Phase 1 runtime foundation status and registered platform capabilities.</p></div>
        {health !== undefined && <div className="flex items-center gap-2 rounded-full border border-slate-700 px-4 py-2 text-sm"><span className={`h-2.5 w-2.5 rounded-full ${statusStyles[health.status]}`} />{health.status}</div>}
      </header>
      {error !== undefined ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-5 text-rose-200">{error}</div> : <div className="grid gap-5 lg:grid-cols-3">
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 lg:col-span-2"><h2 className="text-lg font-semibold">Runtime</h2><dl className="mt-5 grid gap-5 sm:grid-cols-3"><Stat label="Application" value={system?.application ?? 'Connecting'} /><Stat label="Environment" value={system?.environment ?? 'Connecting'} /><Stat label="State" value={system?.runtime ?? 'Connecting'} /></dl></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6"><h2 className="text-lg font-semibold">Health checks</h2><div className="mt-4 space-y-3">{Object.entries(health?.checks ?? {}).map(([name, check]) => <div className="flex items-center justify-between text-sm" key={name}><span className="text-slate-300">{name}</span><span className="capitalize text-slate-400">{check.status}</span></div>)}{health === undefined && <p className="text-sm text-slate-500">Waiting for health report…</p>}</div></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 lg:col-span-2"><h2 className="text-lg font-semibold">Foundation services</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{system?.services.map((service) => <div className="rounded-lg bg-slate-800/70 px-4 py-3" key={service.id}><p className="font-mono text-sm text-nexus-500">{service.id}</p><p className="mt-1 text-xs text-slate-500">{service.tags.join(' · ') || 'platform service'}</p></div>) ?? <p className="text-sm text-slate-500">Loading service registry…</p>}</div></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6"><h2 className="text-lg font-semibold">Feature flags</h2><div className="mt-4 space-y-2">{Object.entries(system?.features ?? {}).map(([name, enabled]) => <div className="flex justify-between text-sm" key={name}><span>{name}</span><span className={enabled ? 'text-emerald-300' : 'text-slate-500'}>{enabled ? 'enabled' : 'disabled'}</span></div>)}{system !== undefined && Object.keys(system.features).length === 0 && <p className="text-sm text-slate-500">No runtime overrides.</p>}</div></article>
      </div>}
    </section>
  </main>;
};

const Stat = ({ label, value }: { readonly label: string; readonly value: string }): JSX.Element => <div><dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt><dd className="mt-1 text-lg font-medium capitalize text-slate-100">{value}</dd></div>;

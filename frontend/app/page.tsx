'use client';

import { useEffect, useState } from 'react';
import { api, qs } from './api';

type Selection = { type: string; id: string; value?: string; label: string };

const STATUS_FA: Record<string, string> = {
  complete: 'کامل', partial: 'میانروز (جزئی)', needs_review: 'نیاز به بررسی', failed: 'خطا',
  running: 'در حال اجرا', pending: 'در انتظار',
};

const SERVICE_KINDS = ['ok', 'failed', 'other', 'missingStatus', 'invalidStatus', 'missingService'];
const SERVICE_FA: Record<string, string> = {
  ok: 'موفق', failed: 'ناموفق', other: 'سایر', missingStatus: 'بدون status',
  invalidStatus: 'status نامعتبر', missingService: 'سرویس موجود نیست',
};

const nf = new Intl.NumberFormat('fa-IR');
function fmt(value: any, digits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return nf.format(Number(n.toFixed(digits)));
}
function pct(value: any): string {
  return value === null || value === undefined ? '—' : `${fmt(value, 2)}٪`;
}
function jalali(date: Date): string {
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month').padStart(2, '0')}-${pick('day').padStart(2, '0')}`;
}
function defaultRange() {
  const now = new Date();
  return { to: jalali(now), from: jalali(new Date(now.getTime() - 29 * 86400000)) };
}
function dt(value: any): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }); } catch { return String(value); }
}

function Kpi({ label, value, hint, tone = 'indigo' }: { label: string; value: any; hint?: string; tone?: string }) {
  const tones: Record<string, string> = {
    indigo: 'from-indigo-500/10 to-indigo-500/5 text-indigo-700 dark:text-indigo-300',
    emerald: 'from-emerald-500/10 to-emerald-500/5 text-emerald-700 dark:text-emerald-300',
    rose: 'from-rose-500/10 to-rose-500/5 text-rose-700 dark:text-rose-300',
    amber: 'from-amber-500/10 to-amber-500/5 text-amber-700 dark:text-amber-300',
  };
  return (
    <div className={`card bg-gradient-to-br ${tones[tone] ?? tones.indigo}`}>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

function Bar({ label, value, max, suffix = '', color = 'bg-indigo-500' }: {
  label: string; value: number; max: number; suffix?: string; color?: string;
}) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{label}</span>
        <span className="whitespace-nowrap font-semibold">{fmt(value)}{suffix}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Histogram({ title, rows, color = 'bg-indigo-500' }: { title: string; rows: any[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0));
  return (
    <div className="card">
      <h3 className="mb-4 text-sm font-bold">{title}</h3>
      {!rows.length ? <p className="text-sm text-slate-500">دادهای در این بازه نیست.</p>
        : rows.map((r) => <Bar key={r.label} label={r.label} value={Number(r.count) || 0} max={max} color={color} />)}
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold">{title}</h2>
      {desc && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{desc}</p>}
    </div>
  );
}

export default function Page() {
  const [range, setRange] = useState(defaultRange);
  const [bank, setBank] = useState('tavan_mellat');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState<Selection>({ type: 'flag', id: 'rotbeNull', label: 'رتبهبندی فاقد داده' });
  const [list, setList] = useState<any>(null);
  const [listOffset, setListOffset] = useState(0);
  const [sample, setSample] = useState<any>(null);

  useEffect(() => {
    const saved = localStorage.getItem('ce-theme');
    const isDark = saved === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    setDark(isDark);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('ce-theme', next ? 'dark' : 'light');
  };

  const loadSummary = async () => {
    setLoading(true); setError('');
    try {
      const result = await api(`/summary${qs({ bank, from: range.from, to: range.to })}`);
      setData(result);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadList = async () => {
    try {
      const result = await api(`/list${qs({
        bank, from: range.from, to: range.to,
        type: selected.type, id: selected.id, value: selected.value,
        limit: 100, offset: listOffset,
      })}`);
      setList(result);
    } catch (e: any) {
      setList({ rows: [], total: 0, error: e?.message ?? String(e) });
    }
  };

  useEffect(() => { loadSummary(); }, [bank, range.from, range.to]);
  useEffect(() => { loadList(); }, [bank, range.from, range.to, selected, listOffset]);

  const select = (next: Selection) => { setSelected(next); setListOffset(0); setTab('lists'); };

  const openSample = async (requestId: string) => {
    setSample({ requestId, loading: true });
    try {
      const result = await api(`/sample/${encodeURIComponent(requestId)}`);
      setSample(result);
    } catch (e: any) {
      setSample({ requestId, error: e?.message ?? String(e) });
    }
  };

  const specs = data?.specs;
  const stats = data?.stats ?? {};
  const run = data?.runs?.[0];
  const flagLabels = new Map<string, string>((specs?.flags ?? []).map((f: any) => [f.id, f.label]));
  const metricSpecs = new Map<string, any>((specs?.metrics ?? []).map((m: any) => [m.id, m]));
  const tabs = [
    { id: 'overview', label: 'نمای کلی' }, { id: 'flags', label: 'شاخصها' },
    { id: 'categories', label: 'دستهها' }, { id: 'quality', label: 'کیفیت داده' },
    { id: 'daily', label: 'روند روزانه' }, { id: 'runs', label: 'اجراها' },
    { id: 'lists', label: 'فهرستها' },
  ];

  return (
    <main className="mx-auto max-w-[1500px] p-4 md:p-6">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <span className="h-2 w-2 rounded-full bg-indigo-500" /> نسخه سروری · داده زنده از PostgreSQL
          </div>
          <h1 className="text-2xl font-black md:text-3xl">داشبورد کنترل کیفیت اعتبارسنجی</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            همان قواعد تحلیل نسخه قبل، ولی با ذخیره ردیفهای تحلیلشده در دیتابیس جانبی. جزئیات کامل نمونه فقط با کلیک و از API اصلی گرفته میشود.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            بانک
            <select className="input mt-1 block" value={bank} onChange={(e) => setBank(e.target.value)}>
              <option value="tavan_mellat">ملت</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            از
            <input className="input mt-1 block" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} placeholder="1405-07-20" />
          </label>
          <label className="text-xs text-slate-500">
            تا
            <input className="input mt-1 block" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} placeholder="1405-08-19" />
          </label>
          <button onClick={loadSummary} className="btn bg-indigo-600 text-white hover:bg-indigo-700">بروزرسانی</button>
          <button onClick={toggleTheme} className="btn border border-slate-300 dark:border-slate-700" title="تغییر تم">
            {dark ? '☀ روشن' : '🌙 تیره'}
          </button>
        </div>
      </header>

      {error && (
        <div className="card mb-4 border-rose-300 bg-rose-50 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          {error}
          <div className="mt-2 text-xs">مطمئن شو بکاند بالاست، migration اجرا شده و متغیرهای .env درست تنظیم شدهاند.</div>
        </div>
      )}
      {loading && <div className="card mb-4 text-sm">در حال دریافت آمار از دیتابیس جانبی…</div>}
      {!data && !loading && !error && <div className="card text-sm">دادهای بارگذاری نشده است.</div>}

      {data && (
        <>
          <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 border-r-4 border-r-indigo-500">
            <div>
              <div className="text-sm font-bold">
                وضعیت آخرین اجرا: {STATUS_FA[run?.status] ?? run?.status ?? 'ثبت نشده'}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {run ? `روز ${run.day} · حالت ${run.mode} · منبع ${fmt(run.source_total)} · پردازش ${fmt(run.ingested_count)} · نسخه ${run.analysis_version ?? '—'}` : 'هنوز اجرایی ثبت نشده است.'}
              </div>
            </div>
            {specs?.bank?.overviewNote && (
              <div className="max-w-2xl text-xs leading-6 text-slate-500 dark:text-slate-400">{specs.bank.overviewNote}</div>
            )}
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="کل گزارشها" value={fmt(stats.total)} hint={`${fmt(stats.days)} روز`} />
            <Kpi label="موفق" value={fmt(stats.success)} tone="emerald" hint={`نرخ ${pct(stats.success_rate)}`} />
            <Kpi label="ناموفق" value={fmt(stats.fail)} tone="rose" />
            <Kpi label="میانه PD" value={fmt(data.metrics?.pd?.median, 3)} hint={`صرفاً روی ${fmt(data.metrics?.pd?.count)} مقدار`} />
            <Kpi label="p95 زمان مدل" value={fmt(data.metrics?.totalTime?.p95, 2)} hint="ثانیه" tone="amber" />
            <Kpi label="بازه" value={`${data.from} → ${data.to}`} />
          </div>

          <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`btn ${tab === t.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Histogram title="توزیع احتمال نکول (PD)" rows={data.histograms?.pd ?? []} color="bg-indigo-500" />
              <Histogram title="زمان اجرای مدل" rows={data.histograms?.totalTime ?? []} color="bg-amber-500" />
              <Histogram title="سبد اعتباری / توان بازپرداخت" rows={data.histograms?.creditBasket ?? []} color="bg-emerald-500" />
              <div className="card lg:col-span-2">
                <SectionTitle title="آمار عددی شاخصها" desc="چارکها مستقیماً با percentile_cont در PostgreSQL محاسبه میشوند." />
                <div className="overflow-x-auto">
                  <table className="table w-full text-left">
                    <thead><tr><th>شاخص</th><th>تعداد</th><th>کمینه</th><th>p25</th><th>میانه</th><th>میانگین</th><th>p75</th><th>p95</th><th>بیشینه</th></tr></thead>
                    <tbody>
                      {Object.values(data.metrics ?? {}).map((m: any) => {
                        const spec = metricSpecs.get(m.id);
                        const digits = spec?.preserveFraction || ['pd'].includes(m.id) ? 3 : 0;
                        return <tr key={m.id}>
                          <td className="font-medium">{m.label}</td><td>{fmt(m.count)}</td>
                          <td>{fmt(m.min, digits)}</td><td>{fmt(m.p25, digits)}</td><td>{fmt(m.median, digits)}</td>
                          <td>{fmt(m.mean, digits)}</td><td>{fmt(m.p75, digits)}</td><td>{fmt(m.p95, digits)}</td><td>{fmt(m.max, digits)}</td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card">
                <SectionTitle title="پر تکرارترین شاخصها" />
                {[...(data.flags ?? [])].sort((a: any, b: any) => b.count - a.count).slice(0, 10).map((f: any) => (
                  <Bar key={f.id} label={f.label} value={f.count} max={stats.total || 1} suffix={` (${pct(f.percent)})`} color="bg-rose-400" />
                ))}
              </div>
            </div>
          )}

          {tab === 'flags' && (
            <div className="card">
              <SectionTitle title="شاخصهای بولی" desc="روی هر ردیف کلیک کن تا فهرست حداکثر ۱۰۰ نمونه مربوطه باز شود." />
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {[...(data.flags ?? [])].sort((a: any, b: any) => b.count - a.count).map((f: any) => (
                  <button key={f.id} onClick={() => select({ type: 'flag', id: f.id, label: f.label })}
                    className="rounded-xl border border-slate-200 p-3 text-right transition-colors hover:border-indigo-400 hover:bg-indigo-50 dark:border-slate-800 dark:hover:bg-slate-800">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium">{f.label}</span>
                      <span className="tag">{f.topic ?? '—'}</span>
                    </div>
                    <div className="mt-3 text-2xl font-bold">{fmt(f.count)}</div>
                    <div className="text-xs text-slate-500">{pct(f.percent)} از کل · {f.daily ? 'روند روزانه دارد' : 'بدون روند'}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'categories' && (
            <div className="grid gap-4 md:grid-cols-2">
              {(data.categories ?? []).map((c: any) => {
                const max = Math.max(1, ...c.values.map((v: any) => v.count));
                return (
                  <div className="card" key={c.id}>
                    <div className="mb-3 flex items-center justify-between">
                      <div><h3 className="text-sm font-bold">{c.label}</h3><p className="text-xs text-slate-500">{c.topic ?? '—'}</p></div>
                      {c.onlyStatus && <span className="tag">فقط {c.onlyStatus === 'success' ? 'موفق' : 'ناموفق'}</span>}
                    </div>
                    {!c.values.length ? <p className="text-sm text-slate-500">مقداری ثبت نشده.</p> : c.values.map((v: any) => (
                      <button key={v.value} onClick={() => select({ type: 'cat', id: c.id, value: v.value, label: `${c.label}: ${v.value}` })}
                        className="mb-2 block w-full text-right">
                        <Bar label={v.value} value={v.count} max={max} color="bg-cyan-500" />
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'quality' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card">
                <SectionTitle title="کیفیت مسیرهای داده" desc="همان emptyKind قدیمی، ولی تجمیعشده در SQL." />
                <div className="overflow-x-auto">
                  <table className="table w-full"><thead><tr><th>مسیر</th><th>انواع نقص</th></tr></thead>
                    <tbody>{(data.dataQuality?.paths ?? []).map((p: any) => (
                      <tr key={p.key}><td className="font-medium">{p.label}</td>
                        <td>{Object.entries(p.kinds ?? {}).map(([k, v]) => <span key={k} className="tag ml-1">{k}: {fmt(v)}</span>)}</td></tr>
                    ))}</tbody></table>
                </div>
              </div>
              <div className="card">
                <SectionTitle title="وضعیت رتبهبندی و سرویسها" />
                <div className="mb-4 flex flex-wrap gap-2">
                  {(data.dataQuality?.rotbe ?? []).map((r: any) => <span key={r.rotbe} className="tag">{r.rotbe}: {fmt(r.count)}</span>)}
                </div>
                <div className="overflow-x-auto">
                  <table className="table w-full"><thead><tr><th>سرویس</th>{SERVICE_KINDS.map((k) => <th key={k}>{SERVICE_FA[k]}</th>)}</tr></thead>
                    <tbody>{(data.services ?? []).map((s: any) => (
                      <tr key={s.key}><td className="font-medium">{s.label}</td>{SERVICE_KINDS.map((k) => <td key={k}>{fmt(s.counts?.[k] ?? 0)}</td>)}</tr>
                    ))}</tbody></table>
                </div>
              </div>
            </div>
          )}

          {tab === 'daily' && (
            <div className="card">
              <SectionTitle title="روند روزانه" desc="تجمیع روزانه از دیتابیس جانبی، نه از API اصلی." />
              <div className="overflow-x-auto">
                <table className="table w-full">
                  <thead><tr><th>روز</th><th>کل</th><th>موفق</th><th>ناموفق</th><th>نرخ موفقیت</th>
                    {(specs?.flags ?? []).filter((f: any) => f.daily).slice(0, 5).map((f: any) => <th key={f.id}>{f.short ?? f.label}</th>)}</tr></thead>
                  <tbody>{(data.daily ?? []).map((d: any) => (
                    <tr key={d.day}><td className="font-medium">{d.day}</td><td>{fmt(d.total)}</td><td>{fmt(d.success)}</td><td>{fmt(d.fail)}</td>
                      <td>{pct(d.total ? (d.success * 100 / d.total) : 0)}</td>
                      {(specs?.flags ?? []).filter((f: any) => f.daily).slice(0, 5).map((f: any) => <td key={f.id}>{fmt(d.flags?.[f.id] ?? 0)}</td>)}</tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <div className="card">
              <SectionTitle title="اجراهای Ingestion" desc="قفل، checkpoint و وضعیت نهایی/جزئی هر روز." />
              <div className="overflow-x-auto">
                <table className="table w-full">
                  <thead><tr><th>روز</th><th>بانک</th><th>حالت</th><th>وضعیت</th><th>منبع</th><th>پردازش</th><th>موفق</th><th>ناموفق</th><th>پرش</th><th>checkpoint</th><th>نسخه</th><th>شروع</th><th>پایان</th></tr></thead>
                  <tbody>{(data.runs ?? []).map((r: any, i: number) => (
                    <tr key={`${r.bank}-${r.day}-${i}`}>
                      <td className="font-medium">{r.day}</td><td>{r.bank}</td><td>{r.mode}</td>
                      <td><span className="tag">{STATUS_FA[r.status] ?? r.status}</span></td>
                      <td>{fmt(r.source_total)}</td><td>{fmt(r.ingested_count)}</td><td>{fmt(r.success_count)}</td>
                      <td>{fmt(r.fail_count)}</td><td>{fmt(r.skipped_count)}</td><td>{fmt(r.checkpoint)}</td>
                      <td>{r.analysis_version ?? '—'}</td><td>{dt(r.started_at)}</td><td>{dt(r.finished_at)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {!data.runs?.length && <p className="mt-3 text-sm text-slate-500">اجرایی ثبت نشده. ابتدا <code>npm run migrate</code> و سپس <code>npm run ingest</code> را اجرا کن.</p>}
            </div>
          )}

          {tab === 'lists' && (
            <div className="card">
              <SectionTitle title="گزارشهای قابل بررسی" desc="حداکثر ۱۰۰ ردیف در هر صفحه؛ شمارش کل با COUNT(*) OVER() انجام میشود." />
              <div className="mb-4 flex flex-wrap items-end gap-2">
                <label className="text-xs text-slate-500">شاخص
                  <select className="input mt-1 block min-w-[260px]" value={`${selected.type}:${selected.id}`}
                    onChange={(e) => {
                      const [type, ...rest] = e.target.value.split(':');
                      const id = rest.join(':');
                      const label = type === 'flag' ? flagLabels.get(id) ?? id
                        : type === 'metric' ? metricSpecs.get(id)?.label ?? id : id;
                      setSelected({ type, id, label }); setListOffset(0);
                    }}>
                    <optgroup label="شاخصهای بولی">{(specs?.flags ?? []).map((f: any) => <option key={f.id} value={`flag:${f.id}`}>{f.label}</option>)}</optgroup>
                    <optgroup label="شاخصهای عددی">{(specs?.metrics ?? []).map((m: any) => <option key={m.id} value={`metric:${m.id}`}>{m.label}</option>)}</optgroup>
                    <optgroup label="دستهها">{(specs?.categories ?? []).map((c: any) => <option key={c.id} value={`cat:${c.id}`}>{c.label}</option>)}</optgroup>
                    <optgroup label="ویژه">
                      <option value="slow:slow">گزارشهای کند (&gt; ۴ ثانیه)</option>
                      <option value="creditAlert:creditAlert">هشدار بدهی معوق / چک برگشتی</option>
                      <option value="all:all">همه گزارشها</option>
                    </optgroup>
                  </select>
                </label>
                {selected.type === 'cat' && (
                  <label className="text-xs text-slate-500">مقدار دسته (خالی = همه)
                    <input className="input mt-1 block" value={selected.value ?? ''} onChange={(e) => { setSelected({ ...selected, value: e.target.value }); setListOffset(0); }} placeholder="مثال empty" />
                  </label>
                )}
                <div className="text-xs text-slate-500">نمایش {fmt(list?.rows?.length ?? 0)} از {fmt(list?.total ?? 0)}</div>
                <button className="btn border border-slate-300 disabled:opacity-40 dark:border-slate-700" disabled={listOffset === 0} onClick={() => setListOffset(Math.max(0, listOffset - 100))}>قبلی</button>
                <button className="btn border border-slate-300 disabled:opacity-40 dark:border-slate-700" disabled={listOffset + 100 >= (list?.total ?? 0)} onClick={() => setListOffset(listOffset + 100)}>بعدی</button>
              </div>
              {list?.error && <div className="mb-3 text-sm text-rose-600">{list.error}</div>}
              <div className="overflow-x-auto">
                <table className="table w-full">
                  <thead><tr><th>request_id</th><th>زمان ثبت</th><th>وضعیت</th><th>مدل</th><th>PD</th><th>زمان (ث)</th><th>توان بازپرداخت (ریال)</th><th>شاخصها</th></tr></thead>
                  <tbody>{(list?.rows ?? []).map((r: any) => (
                    <tr key={r.request_id}>
                      <td><button onClick={() => openSample(r.request_id)} className="font-mono text-xs text-indigo-600 underline decoration-dotted dark:text-indigo-300">{r.request_id}</button></td>
                      <td>{r.inserted_at ?? '—'}</td>
                      <td>{r.is_success ? <span className="tag text-emerald-600">موفق</span> : <span className="tag text-rose-600">ناموفق</span>}</td>
                      <td>{r.model_name ?? '—'}</td><td>{fmt(r.pd, 3)}</td><td>{fmt(r.total_time_s, 2)}</td>
                      <td>{fmt(r.suggested_amount)}</td>
                      <td>{(r.true_flags ?? []).slice(0, 3).map((id: string) => <span key={id} className="tag ml-1">{flagLabels.get(id) ?? id}</span>)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {!list?.rows?.length && !list?.error && <p className="mt-3 text-sm text-slate-500">موردی برای این شاخص پیدا نشد.</p>}
            </div>
          )}
        </>
      )}

      {sample && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSample(null)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
              <div><div className="text-sm font-bold">جزئیات نمونه</div><div className="font-mono text-xs text-slate-500">{sample.requestId}</div></div>
              <button className="btn border border-slate-300 dark:border-slate-700" onClick={() => setSample(null)}>بستن</button>
            </div>
            <div className="p-4">
              {sample.loading && <div className="text-sm">در حال دریافت از API اصلی…</div>}
              {sample.error && <div className="text-sm text-rose-600">{sample.error}</div>}
              {sample.note && <div className="mb-3 text-xs text-slate-500">{sample.note}</div>}
              {sample.sample && <pre dir="ltr" className="max-h-[65vh] overflow-auto rounded-xl bg-slate-950 p-4 text-left text-xs leading-5 text-slate-100">{JSON.stringify(sample.sample, null, 2)}</pre>}
              {sample.found === false && !sample.loading && <div className="text-sm text-amber-600">نمونهای با این request_id در API اصلی پیدا نشد.</div>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

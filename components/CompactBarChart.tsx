import React from 'react';

type CompactBarChartRow = {
  key: string;
  label: string;
  values: number[];
  valueLabel?: string;
  highlight?: boolean;
};

type CompactBarChartProps = {
  rows: CompactBarChartRow[];
  seriesColors: string[];
  emptyLabel?: string;
  maxItems?: number;
};

const currency = new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG', maximumFractionDigits: 0 });

export const CompactBarChart = ({ rows, seriesColors, emptyLabel = 'Sin datos', maxItems = 10 }: CompactBarChartProps) => {
  const limited = rows.slice(0, maxItems);
  const maxValue = limited.reduce((acc, row) => {
    const rowTotal = row.values.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
    return Math.max(acc, rowTotal);
  }, 0);

  if (!limited.length) {
    return <div className="py-8 text-center text-sm text-slate-400">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-3">
      {limited.map((row) => {
        const safeValues = row.values.map((n) => (Number.isFinite(n) ? Math.max(0, n) : 0));
        const total = safeValues.reduce((sum, n) => sum + n, 0);
        const widthPct = maxValue > 0 ? (total / maxValue) * 100 : 0;
        return (
          <div key={row.key} className={`rounded-md px-2 py-2 ${row.highlight ? 'bg-blue-50/70' : ''}`}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-semibold text-slate-700">{row.label}</span>
              <span className="shrink-0 text-slate-500">{row.valueLabel ?? currency.format(total)}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded bg-slate-100">
              <div className="flex h-full" style={{ width: `${widthPct}%` }}>
                {safeValues.map((value, i) => {
                  const segmentPct = total > 0 ? (value / total) * 100 : 0;
                  return (
                    <div
                      key={`${row.key}-${i}`}
                      className="h-full"
                      style={{ width: `${segmentPct}%`, backgroundColor: seriesColors[i] || '#334155' }}
                      title={currency.format(value)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

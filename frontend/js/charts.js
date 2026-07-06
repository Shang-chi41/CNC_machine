/**
 * js/charts.js
 * Chart.js wrapper dung chung cho monitor.html va history.html.
 * Yeu cau Chart.js da duoc load qua <script src=".../chart.umd.min.js">
 * truoc khi import module nay.
 *
 * Su dung:
 *   import { createLineChart, pushChart, pushRolling, clearCharts, AXIS_COLORS } from '/static/js/charts.js';
 *   const cPos = createLineChart('chartPos', [
 *       { label:'X', color:AXIS_COLORS.x },
 *       { label:'Y', color:AXIS_COLORS.y },
 *       { label:'Z', color:AXIS_COLORS.z },
 *   ]);
 */

export const AXIS_COLORS = { x: '#e74c3c', y: '#00b894', z: '#3498db', i: '#f39c12' };

/**
 * Tao 1 line chart Chart.js theo style ISA-101 (truc mo, luoi mo, khong legend).
 *
 * @param {string} canvasId          - id cua the <canvas>
 * @param {Array<{label:string,color:string,dash?:boolean}>} fields - cac dataset
 * @param {{maxTicks?:number, fontSize?:number}} opts
 * @returns {Chart|null}
 */
export function createLineChart(canvasId, fields, opts = {}) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return null;

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: fields.map(f => ({
                label: f.label,
                data: [],
                borderColor: f.color,
                borderWidth: 1.5,
                pointRadius: 1,
                tension: 0.3,
                fill: false,
                ...(f.dash ? { borderDash: [4, 3] } : {}),
            })),
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { mode: 'index', intersect: false },
            },
            scales: {
                x: {
                    ticks: { color: 'var(--text-muted)', maxTicksLimit: opts.maxTicks || 6, font: { size: opts.fontSize || 8 } },
                    grid: { color: 'var(--gray-border)' },
                },
                y: {
                    ticks: { color: 'var(--text-muted)', font: { size: opts.fontSize || 8 }, callback: v => v.toFixed(1) },
                    grid: { color: 'var(--gray-border)' },
                },
            },
        },
    });
}

/** Xoa toan bo data cua nhieu chart (giu nguyen cau hinh). */
export function clearCharts(charts) {
    charts.forEach(c => {
        if (!c) return;
        c.data.labels = [];
        c.data.datasets.forEach(d => (d.data = []));
    });
}

/** Them 1 diem vao chart (dung khi build lai toan bo history, goi chart.update() sau khi xong vong lap). */
export function pushChart(chart, label, values) {
    if (!chart) return;
    chart.data.labels.push(label);
    values.forEach((v, i) => chart.data.datasets[i]?.data.push(v));
}

/** Them 1 diem realtime, tu dong cat bot neu vuot qua maxPoints (rolling window), cap nhat ngay khong animation. */
export function pushRolling(chart, label, values, maxPoints) {
    if (!chart) return;
    chart.data.labels.push(label);
    values.forEach((v, i) => chart.data.datasets[i]?.data.push(v));
    if (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
    }
    chart.update('none');
}
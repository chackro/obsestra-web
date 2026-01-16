/**
 * Queue Time Series Visualization
 *
 * Big line chart showing 24-hour queue cycles for top POEs.
 * X = hours (0-23), Y = queue delay (minutes)
 *
 * NOTE: Shows only actual truck queue delay, NOT closure dwell time.
 * Closure dwell (time-until-port-opens) is tracked separately in _decomposed.
 * This prevents the 60-min countdown pattern from contaminating congestion charts.
 *
 * Animated vertical marker shows current hour.
 * Legend with trend arrows (green up, red down).
 */

// POE colors for chart lines
const POE_COLORS = {
    laredo: '#ff6b6b',           // red
    hidalgo_pharr: '#4ecdc4',    // teal
    otay_mesa: '#ffe66d',        // yellow
    nogales: '#95e1d3',          // mint
    brownsville: '#f38181',      // coral
    calexico_east: '#aa96da',    // purple
    tecate: '#fcbad3',           // pink
    douglas: '#a8d8ea',          // light blue
    san_luis: '#ffd3b6',         // peach
    roma: '#c9cba3',             // olive
};

export class QueueTimeSeries {
    constructor(queueData, topPoes) {
        this.data = queueData;      // { "0": { poe: val, ... }, "1": {...}, ... }
        this.poes = topPoes;        // ['laredo', 'hidalgo_pharr', ...]
        this.currentHour = 0;
        this.visible = false;

        // Chart dimensions (will be set relative to canvas)
        this.chartX = 40;
        this.chartY = 0;
        this.chartWidth = 0;
        this.chartHeight = 0;

        // Precompute min/max for Y scaling
        this._computeScale();
    }

    _computeScale() {
        let maxVal = 0;
        for (let h = 0; h < 24; h++) {
            const hourData = this.data[String(h)];
            if (!hourData) continue;
            for (const poe of this.poes) {
                const val = hourData[poe] || 0;
                if (val > maxVal) maxVal = val;
            }
        }
        this.maxQueue = maxVal || 1000;
        // Round up to nice number
        this.maxQueue = Math.ceil(this.maxQueue / 200) * 200;
    }

    setHour(hour) {
        this.currentHour = Math.floor(hour) % 24;
    }

    getQueueValue(poe, hour) {
        return this.data[String(hour)]?.[poe] || 0;
    }

    getChange(poe, hour) {
        const curr = this.getQueueValue(poe, hour);
        const prev = this.getQueueValue(poe, (hour + 23) % 24);
        return curr - prev;  // positive = growing queue
    }

    /**
     * Draw the time series chart.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} canvasWidth
     * @param {number} canvasHeight
     */
    draw(ctx, canvasWidth, canvasHeight) {
        if (!this.visible) return;

        // Chart positioning: bottom-left, ~60% width, ~40% height
        const margin = 40;
        this.chartWidth = canvasWidth * 0.55;
        this.chartHeight = canvasHeight * 0.35;
        this.chartX = margin;
        this.chartY = canvasHeight - this.chartHeight - margin - 60;  // Leave room for legend

        ctx.save();

        // Semi-transparent background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(
            this.chartX - 10,
            this.chartY - 30,
            this.chartWidth + 50,
            this.chartHeight + 100
        );

        // Title
        ctx.font = '14px "IBM Plex Mono", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Queue Delay (minutes, excludes closure dwell)', this.chartX, this.chartY - 10);

        // Draw axes
        this._drawAxes(ctx);

        // Draw lines for each POE
        for (const poe of this.poes) {
            this._drawPoeLine(ctx, poe);
        }

        // Draw current hour marker
        this._drawHourMarker(ctx);

        // Draw legend with arrows
        this._drawLegend(ctx, canvasHeight);

        ctx.restore();
    }

    _drawAxes(ctx) {
        const { chartX, chartY, chartWidth, chartHeight } = this;

        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;

        // Y axis
        ctx.beginPath();
        ctx.moveTo(chartX, chartY);
        ctx.lineTo(chartX, chartY + chartHeight);
        ctx.stroke();

        // X axis
        ctx.beginPath();
        ctx.moveTo(chartX, chartY + chartHeight);
        ctx.lineTo(chartX + chartWidth, chartY + chartHeight);
        ctx.stroke();

        // Y axis labels
        ctx.font = '10px "IBM Plex Mono", monospace';
        ctx.fillStyle = '#888';
        ctx.textAlign = 'right';
        const ySteps = 5;
        for (let i = 0; i <= ySteps; i++) {
            const val = Math.round((this.maxQueue / ySteps) * (ySteps - i));
            const y = chartY + (chartHeight / ySteps) * i;
            ctx.fillText(String(val), chartX - 5, y + 3);

            // Grid line
            ctx.strokeStyle = '#222';
            ctx.beginPath();
            ctx.moveTo(chartX, y);
            ctx.lineTo(chartX + chartWidth, y);
            ctx.stroke();
        }

        // X axis labels (hours)
        ctx.textAlign = 'center';
        ctx.fillStyle = '#888';
        for (let h = 0; h <= 24; h += 4) {
            const x = chartX + (chartWidth / 24) * h;
            ctx.fillText(String(h), x, chartY + chartHeight + 15);
        }
    }

    _drawPoeLine(ctx, poe) {
        const { chartX, chartY, chartWidth, chartHeight, maxQueue } = this;
        const color = POE_COLORS[poe] || '#ffffff';

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let h = 0; h < 24; h++) {
            const val = this.getQueueValue(poe, h);
            const x = chartX + (chartWidth / 23) * h;
            const y = chartY + chartHeight - (val / maxQueue) * chartHeight;

            if (h === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    }

    _drawHourMarker(ctx) {
        const { chartX, chartY, chartWidth, chartHeight, currentHour } = this;
        const x = chartX + (chartWidth / 23) * currentHour;

        // Vertical line
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartY);
        ctx.lineTo(x, chartY + chartHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        // Hour label
        ctx.font = 'bold 12px "IBM Plex Mono", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(`Hour: ${currentHour}`, x, chartY + chartHeight + 30);

        // Draw dots at current hour for each POE
        for (const poe of this.poes) {
            const val = this.getQueueValue(poe, currentHour);
            const y = chartY + chartHeight - (val / this.maxQueue) * chartHeight;
            const color = POE_COLORS[poe] || '#ffffff';

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    _drawLegend(ctx, canvasHeight) {
        const { chartX, chartWidth, currentHour } = this;
        const legendY = this.chartY + this.chartHeight + 50;
        const itemWidth = 120;

        ctx.font = '11px "IBM Plex Mono", monospace';

        for (let i = 0; i < this.poes.length; i++) {
            const poe = this.poes[i];
            const color = POE_COLORS[poe] || '#ffffff';
            const x = chartX + (i % 4) * itemWidth;
            const y = legendY + Math.floor(i / 4) * 18;

            // Color dot
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x + 5, y - 3, 4, 0, Math.PI * 2);
            ctx.fill();

            // POE name (shortened)
            ctx.fillStyle = '#ccc';
            const shortName = poe.replace('hidalgo_', '').replace('_east', '').substring(0, 10);
            ctx.textAlign = 'left';
            ctx.fillText(shortName, x + 12, y);

            // Trend arrow
            const change = this.getChange(poe, currentHour);
            if (Math.abs(change) > 5) {  // Threshold for showing arrow
                const arrowX = x + 80;
                if (change > 0) {
                    ctx.fillStyle = '#4caf50';  // green
                    ctx.fillText('\u2191', arrowX, y);  // up arrow
                } else {
                    ctx.fillStyle = '#f44336';  // red
                    ctx.fillText('\u2193', arrowX, y);  // down arrow
                }
            }
        }
    }
}

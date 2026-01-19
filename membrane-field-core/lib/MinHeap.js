// ═══════════════════════════════════════════════════════════════════════════════
// MinHeap — Priority queue for Dijkstra and other graph algorithms
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Binary min-heap for [priority, value] tuples.
 * Used by Dijkstra's algorithm for O(log n) priority queue operations.
 */
export class MinHeap {
    constructor() {
        this.data = [];
    }

    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }

    pop() {
        if (this.data.length === 0) return null;
        
        const result = this.data[0];
        const last = this.data.pop();
        
        if (this.data.length > 0) {
            this.data[0] = last;
            this._sinkDown(0);
        }
        
        return result;
    }

    peek() {
        return this.data[0] ?? null;
    }

    isEmpty() {
        return this.data.length === 0;
    }

    get size() {
        return this.data.length;
    }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent][0] <= this.data[i][0]) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }

    _sinkDown(i) {
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            
            if (left < this.data.length && this.data[left][0] < this.data[smallest][0]) {
                smallest = left;
            }
            if (right < this.data.length && this.data[right][0] < this.data[smallest][0]) {
                smallest = right;
            }
            
            if (smallest === i) break;
            
            [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
            i = smallest;
        }
    }
}

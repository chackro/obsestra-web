// ═══════════════════════════════════════════════════════════════════════════════
// Grid Utilities — Cell indexing and neighbor iteration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get 4-connected neighbors of a cell (N, S, E, W).
 * Returns array of valid neighbor indices.
 * 
 * @param {number} idx - Cell index (0 to N²-1)
 * @param {number} N - Grid dimension (cells per side)
 * @returns {number[]} Array of neighbor indices
 */
export function getNeighbors4(idx, N) {
    const x = idx % N;
    const y = Math.floor(idx / N);
    const neighbors = [];
    
    if (x > 0)     neighbors.push(idx - 1);     // West
    if (x < N - 1) neighbors.push(idx + 1);     // East
    if (y > 0)     neighbors.push(idx - N);     // North
    if (y < N - 1) neighbors.push(idx + N);     // South
    
    return neighbors;
}

/**
 * Get 8-connected neighbors of a cell (includes diagonals).
 * Returns array of valid neighbor indices.
 * 
 * @param {number} idx - Cell index
 * @param {number} N - Grid dimension
 * @returns {number[]} Array of neighbor indices
 */
export function getNeighbors8(idx, N) {
    const x = idx % N;
    const y = Math.floor(idx / N);
    const neighbors = [];
    
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < N && ny >= 0 && ny < N) {
                neighbors.push(ny * N + nx);
            }
        }
    }
    
    return neighbors;
}

/**
 * Convert cell index to (x, y) coordinates.
 * 
 * @param {number} idx - Cell index
 * @param {number} N - Grid dimension
 * @returns {{x: number, y: number}}
 */
export function idxToXY(idx, N) {
    return {
        x: idx % N,
        y: Math.floor(idx / N)
    };
}

/**
 * Convert (x, y) coordinates to cell index.
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} N - Grid dimension
 * @returns {number} Cell index
 */
export function xyToIdx(x, y, N) {
    return y * N + x;
}

/**
 * Check if (x, y) is within grid bounds.
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} N - Grid dimension
 * @returns {boolean}
 */
export function inBounds(x, y, N) {
    return x >= 0 && x < N && y >= 0 && y < N;
}

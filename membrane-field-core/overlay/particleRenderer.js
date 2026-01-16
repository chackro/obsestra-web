// ═══════════════════════════════════════════════════════════════════════════════
// WebGL Particle Renderer
// High-performance particle rendering using GPU acceleration
// Supports per-particle colors for debug visualization
// ═══════════════════════════════════════════════════════════════════════════════

const VERTEX_SHADER_SRC = `
attribute vec2 a_position;  // World coords (meters)
attribute vec3 a_color;     // Per-particle RGB color
uniform vec2 u_resolution;  // Canvas size (pixels)
uniform vec2 u_center;      // Camera center (world coords)
uniform float u_zoom;       // px/meter
uniform float u_pointSize;  // Line width (pixels)
varying vec3 v_color;       // Pass color to fragment shader

void main() {
    // World -> Screen pixels
    vec2 screenPx = (a_position - u_center) * u_zoom + u_resolution * 0.5;

    // Snap to pixel grid to prevent sub-pixel anti-aliasing shimmer
    screenPx = floor(screenPx) + 0.5;

    // Screen pixels -> NDC
    vec2 ndc = (screenPx - u_resolution * 0.5) / (u_resolution * 0.5);

    gl_Position = vec4(ndc, 0.0, 1.0);
    gl_PointSize = u_pointSize;
    v_color = a_color;
}
`;

const FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec3 v_color;

void main() {
    vec2 delta = gl_PointCoord - vec2(0.5);
    if (length(delta) > 0.5) discard;  // Circle mask
    gl_FragColor = vec4(v_color, 1.0);
}
`;

export class ParticleRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = null;
        this.program = null;
        this.positionBuffer = null;
        this.colorBuffer = null;
        this.positionLocation = -1;
        this.colorLocation = -1;
        this.uniforms = {};
        this.initialized = false;
        this.maxParticles = 60000;

        this._init();
    }

    _init() {
        const gl = this.canvas.getContext('webgl', {
            antialias: false,
            premultipliedAlpha: true,
            alpha: true,
        });

        if (!gl) {
            console.error('[ParticleRenderer] WebGL not supported');
            return;
        }

        this.gl = gl;

        // Compile shaders
        const vs = this._compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
        const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
        if (!vs || !fs) return;

        // Link program
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('[ParticleRenderer] Program link error:', gl.getProgramInfoLog(program));
            return;
        }

        this.program = program;

        // Get attribute/uniform locations
        this.positionLocation = gl.getAttribLocation(program, 'a_position');
        this.colorLocation = gl.getAttribLocation(program, 'a_color');
        this.uniforms = {
            resolution: gl.getUniformLocation(program, 'u_resolution'),
            center: gl.getUniformLocation(program, 'u_center'),
            zoom: gl.getUniformLocation(program, 'u_zoom'),
            pointSize: gl.getUniformLocation(program, 'u_pointSize'),
        };

        // Create position buffer (pre-allocated for max particles)
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxParticles * 2 * 4, gl.DYNAMIC_DRAW);  // 2 floats per particle

        // Create color buffer (pre-allocated for max particles)
        this.colorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxParticles * 3 * 4, gl.DYNAMIC_DRAW);  // 3 floats (RGB) per particle

        // Enable blending for alpha
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.initialized = true;
        console.log('[ParticleRenderer] WebGL initialized with per-particle colors');
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
            console.error(`[ParticleRenderer] ${typeName} shader compile error:`, gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    /**
     * Upload particle positions to GPU
     * @param {Float32Array} positions - Flat array [x0, y0, x1, y1, ...]
     * @param {number} count - Number of particles
     */
    updatePositions(positions, count) {
        if (!this.initialized) return;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        // Upload only the used portion
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions.subarray(0, count * 2));
        this._particleCount = count;
    }

    /**
     * Upload particle colors to GPU
     * @param {Float32Array} colors - Flat array [r0, g0, b0, r1, g1, b1, ...] values 0-1
     * @param {number} count - Number of particles
     */
    updateColors(colors, count) {
        if (!this.initialized) return;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors.subarray(0, count * 3));
    }

    /**
     * Render particles
     * @param {Object} camera - Camera with centerWorld, zoom, canvasWidth, canvasHeight
     * @param {number} pointSize - Point size in pixels
     */
    draw(camera, pointSize = 6) {
        if (!this.initialized || !this._particleCount) return;

        const gl = this.gl;

        // Update viewport if canvas size changed
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        // NOTE: Do NOT clear here - overlay manages its own clearing
        // Multiple draw() calls are used for separate particle batches (moving + lot)

        // Use program
        gl.useProgram(this.program);

        // Set uniforms
        gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
        gl.uniform2f(this.uniforms.center, camera.centerWorld.x, camera.centerWorld.y);
        gl.uniform1f(this.uniforms.zoom, camera.zoom);
        gl.uniform1f(this.uniforms.pointSize, pointSize);

        // Bind position buffer and set attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

        // Bind color buffer and set attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.enableVertexAttribArray(this.colorLocation);
        gl.vertexAttribPointer(this.colorLocation, 3, gl.FLOAT, false, 0, 0);

        // Draw
        gl.drawArrays(gl.POINTS, 0, this._particleCount);
    }

    /**
     * Handle canvas resize
     */
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        if (this.gl) {
            this.gl.viewport(0, 0, width, height);
        }
    }

    /**
     * Check if WebGL is available
     */
    isAvailable() {
        return this.initialized;
    }
}

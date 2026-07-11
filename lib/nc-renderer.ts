export type PointSelection = { index: number; x: number; y: number; z: number };

type Bounds = { min: [number, number, number]; max: [number, number, number] };
type AxisProjection = { x: [number, number]; y: [number, number]; z: [number, number] };
type Options = {
  onPick: (point: PointSelection | null) => void;
  onHover: (point: PointSelection | null) => void;
  onAxesChange?: (axes: AxisProjection) => void;
};
type Chunk = { buffer: WebGLBuffer; start: number; count: number; bufferStart: number; bufferCount: number };

const CHUNK_POINTS = 750_000;

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat3 uRotation;
uniform vec3 uTarget;
uniform vec2 uViewport;
uniform float uScale;
uniform float uPointSize;
uniform float uDepthScale;
out float vDepth;
void main() {
  vec3 p = uRotation * (aPosition - uTarget);
  vec2 clip = p.xy * uScale * 2.0 / uViewport;
  gl_Position = vec4(clip, clamp(p.z / uDepthScale, -0.99, 0.99), 1.0);
  gl_PointSize = uPointSize;
  vDepth = p.z;
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform bool uRound;
uniform float uDepthScale;
in float vDepth;
out vec4 outColor;
void main() {
  vec4 shaded = uColor;
  float depthLight = clamp(.96 - .10 * (vDepth / uDepthScale), .82, 1.08);
  if (uRound) {
    vec2 disk = gl_PointCoord * 2.0 - 1.0;
    float radius2 = dot(disk, disk);
    if (radius2 > 1.0) discard;
    vec3 normal = normalize(vec3(disk, sqrt(max(0.0, 1.0 - radius2))));
    vec3 lightDirection = normalize(vec3(-.45, .55, .9));
    float diffuse = .58 + .42 * max(dot(normal, lightDirection), 0.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
    shaded.rgb = shaded.rgb * diffuse * depthLight + vec3(specular * .2);
    shaded.a *= 1.0 - smoothstep(.78, 1.0, radius2);
  } else {
    shaded.rgb *= depthLight;
  }
  outColor = shaded;
}`;

const pickVertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat3 uRotation;
uniform vec3 uTarget;
uniform vec2 uViewport;
uniform float uScale;
uniform int uOffset;
uniform float uDepthScale;
flat out uint vId;
void main() {
  vec3 p = uRotation * (aPosition - uTarget);
  gl_Position = vec4(p.xy * uScale * 2.0 / uViewport, clamp(p.z / uDepthScale, -0.99, .99), 1.0);
  gl_PointSize = 13.0;
  vId = uint(uOffset + gl_VertexID + 1);
}`;

const pickFragmentSource = `#version 300 es
precision highp float;
flat in uint vId;
out vec4 outColor;
void main() {
  if (distance(gl_PointCoord, vec2(.5)) > .5) discard;
  outColor = vec4(float(vId & 255u), float((vId >> 8u) & 255u), float((vId >> 16u) & 255u), float((vId >> 24u) & 255u)) / 255.0;
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Shader 编译失败");
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const result = gl.createProgram()!;
  gl.attachShader(result, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(result, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) || "Shader 链接失败");
  return result;
}

type Quaternion = [number, number, number, number];

function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return normalizeQuaternion([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

function blendQuaternion(from: Quaternion, to: Quaternion, amount: number): Quaternion {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  const sign = dot < 0 ? -1 : 1;
  return normalizeQuaternion([
    from[0] * (1 - amount) + to[0] * amount * sign,
    from[1] * (1 - amount) + to[1] * amount * sign,
    from[2] * (1 - amount) + to[2] * amount * sign,
    from[3] * (1 - amount) + to[3] * amount * sign,
  ]);
}

function axisAngle(x: number, y: number, z: number, angle: number): Quaternion {
  const half = angle / 2, sine = Math.sin(half);
  return [x * sine, y * sine, z * sine, Math.cos(half)];
}

function quaternionFromVectors(from: [number, number, number], to: [number, number, number]): Quaternion {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  const cross: [number, number, number] = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ];
  if (dot < -0.999999) {
    const axis = Math.abs(from[0]) < 0.8 ? [0, -from[2], from[1]] : [-from[1], from[0], 0];
    const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    return [axis[0] / length, axis[1] / length, axis[2] / length, 0];
  }
  return normalizeQuaternion([cross[0], cross[1], cross[2], 1 + dot]);
}

function rotationMatrix(q: Quaternion): Float32Array {
  const [x, y, z, w] = q;
  return new Float32Array([
    1 - 2 * y * y - 2 * z * z, 2 * x * y + 2 * z * w, 2 * x * z - 2 * y * w,
    2 * x * y - 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z + 2 * x * w,
    2 * x * z + 2 * y * w, 2 * y * z - 2 * x * w, 1 - 2 * x * x - 2 * y * y,
  ]);
}

export class NCWebGLRenderer {
  private gl: WebGL2RenderingContext;
  private renderProgram: WebGLProgram;
  private pickProgram: WebGLProgram;
  private pickFramebuffer: WebGLFramebuffer;
  private pickTexture: WebGLTexture;
  private pickDepth: WebGLRenderbuffer;
  private chunks: Chunk[] = [];
  private positions: Float32Array<ArrayBufferLike> = new Float32Array();
  private bounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0] };
  private radius = 1;
  private target: [number, number, number] = [0, 0, 0];
  private scale = 1;
  private orientation: Quaternion = multiplyQuaternion(axisAngle(1, 0, 0, 0.72), axisAngle(0, 0, 1, -0.7));
  private selected: number | null = null;
  private simulationIndex: number | null = null;
  private options = { showPath: true, showPoints: true, pointSize: 3 };
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private pointerDown: {
    x: number;
    y: number;
    button: number;
    moved: boolean;
    sphere: [number, number, number];
  } | null = null;
  private handlers: Options;

  constructor(private canvas: HTMLCanvasElement, handlers: Options) {
    const gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("当前浏览器或显卡不支持 WebGL 2.0。");
    this.gl = gl;
    this.handlers = handlers;
    this.renderProgram = program(gl, vertexSource, fragmentSource);
    this.pickProgram = program(gl, pickVertexSource, pickFragmentSource);
    this.pickFramebuffer = gl.createFramebuffer()!;
    this.pickTexture = gl.createTexture()!;
    this.pickDepth = gl.createRenderbuffer()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    this.resizeObserver = new ResizeObserver(() => { this.resize(); this.draw(); });
    this.resizeObserver.observe(canvas);
    this.bindEvents();
    this.resize();
  }

  setData(positions: Float32Array, bounds: Bounds) {
    const gl = this.gl;
    this.chunks.forEach((chunk) => gl.deleteBuffer(chunk.buffer));
    this.chunks = [];
    this.positions = positions;
    this.bounds = bounds;
    const count = positions.length / 3;
    for (let start = 0; start < count; start += CHUNK_POINTS) {
      const chunkCount = Math.min(CHUNK_POINTS, count - start);
      const bufferStart = Math.max(0, start - 1);
      const bufferCount = chunkCount + (start > 0 ? 1 : 0);
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions.subarray(bufferStart * 3, (start + chunkCount) * 3), gl.STATIC_DRAW);
      this.chunks.push({ buffer, start, count: chunkCount, bufferStart, bufferCount });
    }
    const dx = bounds.max[0] - bounds.min[0], dy = bounds.max[1] - bounds.min[1], dz = bounds.max[2] - bounds.min[2];
    this.radius = Math.max(Math.hypot(dx, dy, dz) / 2, 1e-9);
    this.fit();
  }

  setOptions(next: Partial<typeof this.options>) { Object.assign(this.options, next); this.draw(); }

  setSimulationIndex(index: number | null) {
    const count = this.positions.length / 3;
    this.simulationIndex = index == null || count === 0 ? null : Math.max(0, Math.min(count - 1, Math.floor(index)));
    this.selected = this.simulationIndex;
    this.draw();
  }

  setView(view: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso") {
    const front = axisAngle(1, 0, 0, -Math.PI / 2);
    if (view === "top") this.orientation = [0, 0, 0, 1];
    if (view === "bottom") this.orientation = axisAngle(1, 0, 0, Math.PI);
    if (view === "front") this.orientation = front;
    if (view === "back") this.orientation = multiplyQuaternion(front, axisAngle(0, 0, 1, Math.PI));
    if (view === "left") this.orientation = multiplyQuaternion(front, axisAngle(0, 0, 1, Math.PI / 2));
    if (view === "right") this.orientation = multiplyQuaternion(front, axisAngle(0, 0, 1, -Math.PI / 2));
    if (view === "iso") this.orientation = multiplyQuaternion(axisAngle(1, 0, 0, 0.72), axisAngle(0, 0, 1, -0.7));
    this.draw();
  }

  fit() {
    this.target = [
      (this.bounds.min[0] + this.bounds.max[0]) / 2,
      (this.bounds.min[1] + this.bounds.max[1]) / 2,
      (this.bounds.min[2] + this.bounds.max[2]) / 2,
    ];
    this.scale = Math.max(1e-12, Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / (this.radius * 2.35));
    this.draw();
  }

  focusPoint(index: number) {
    if (index < 0 || index * 3 + 2 >= this.positions.length) return;
    this.selected = index;
    this.target = [this.positions[index * 3], this.positions[index * 3 + 1], this.positions[index * 3 + 2]];
    this.scale = Math.max(this.scale, Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / Math.max(this.radius * 0.08, 1e-9));
    this.draw();
  }

  clearSelection() { this.selected = null; this.draw(); }

  private uniforms(renderProgram: WebGLProgram) {
    const gl = this.gl;
    gl.uniformMatrix3fv(gl.getUniformLocation(renderProgram, "uRotation"), false, rotationMatrix(this.orientation));
    gl.uniform3fv(gl.getUniformLocation(renderProgram, "uTarget"), this.target);
    gl.uniform2f(gl.getUniformLocation(renderProgram, "uViewport"), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(renderProgram, "uScale"), this.scale * devicePixelRatio);
    gl.uniform1f(gl.getUniformLocation(renderProgram, "uDepthScale"), Math.max(this.radius * 2, 1e-9));
  }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const gl = this.gl;
      const matrix = rotationMatrix(this.orientation);
      this.handlers.onAxesChange?.({
        x: [matrix[0], -matrix[1]],
        y: [matrix[3], -matrix[4]],
        z: [matrix[6], -matrix[7]],
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.renderProgram);
      this.uniforms(this.renderProgram);
      const color = gl.getUniformLocation(this.renderProgram, "uColor");
      const round = gl.getUniformLocation(this.renderProgram, "uRound");
      const size = gl.getUniformLocation(this.renderProgram, "uPointSize");
      for (const chunk of this.chunks) {
        gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        const visibleCount = this.simulationIndex == null
          ? chunk.count
          : Math.max(0, Math.min(chunk.count, this.simulationIndex - chunk.start + 1));
        const visibleLineCount = visibleCount > 0 ? visibleCount + (chunk.start > 0 ? 1 : 0) : 0;
        if (this.options.showPath) {
          if (this.simulationIndex != null) {
            gl.uniform4f(color, 0.28, 0.36, 0.43, 0.78); gl.uniform1i(round, 0); gl.uniform1f(size, 1);
            gl.drawArrays(gl.LINE_STRIP, 0, chunk.bufferCount);
          }
          if (visibleLineCount > 0) {
            gl.uniform4f(color, 0.04, 0.42, 0.72, 0.9); gl.uniform1i(round, 0); gl.uniform1f(size, 1);
            gl.drawArrays(gl.LINE_STRIP, 0, visibleLineCount);
          }
        }
        if (this.options.showPoints) {
          const first = chunk.start - chunk.bufferStart;
          if (this.simulationIndex != null) {
            gl.uniform4f(color, 0.32, 0.42, 0.54, 0.68); gl.uniform1i(round, 1); gl.uniform1f(size, this.options.pointSize * devicePixelRatio);
            gl.drawArrays(gl.POINTS, first, chunk.count);
          }
          if (visibleCount > 0) {
            gl.uniform4f(color, 0.18, 0.38, 0.98, 0.96); gl.uniform1i(round, 1); gl.uniform1f(size, this.options.pointSize * devicePixelRatio);
            gl.drawArrays(gl.POINTS, first, visibleCount);
          }
        }
      }
      if (this.selected != null) this.drawSelected();
    });
  }

  private drawSelected() {
    const gl = this.gl, index = this.selected!;
    const chunk = this.chunks.find((item) => index >= item.start && index < item.start + item.count);
    if (!chunk) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4f(gl.getUniformLocation(this.renderProgram, "uColor"), 0.95, 0.38, 0.16, 1);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uRound"), 1);
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, "uPointSize"), 13 * devicePixelRatio);
    gl.drawArrays(gl.POINTS, index - chunk.bufferStart, 1);
  }

  private pick(clientX: number, clientY: number, commit: boolean) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.pickProgram);
    this.uniforms(this.pickProgram);
    for (const chunk of this.chunks) {
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1i(gl.getUniformLocation(this.pickProgram, "uOffset"), chunk.bufferStart);
      gl.drawArrays(gl.POINTS, chunk.start - chunk.bufferStart, chunk.count);
    }
    const pixel = new Uint8Array(4);
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.floor((clientX - rect.left) * devicePixelRatio)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, Math.floor((rect.bottom - clientY) * devicePixelRatio)));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    const encoded = pixel[0] + pixel[1] * 256 + pixel[2] * 65536 + pixel[3] * 16777216;
    const index = encoded - 1;
    const point = index >= 0 && index * 3 + 2 < this.positions.length
      ? { index, x: this.positions[index * 3], y: this.positions[index * 3 + 1], z: this.positions[index * 3 + 2] }
      : null;
    if (commit) { this.selected = point?.index ?? null; this.handlers.onPick(point); }
    else this.handlers.onHover(point);
    this.draw();
  }

  private bindEvents() {
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("pointerdown", (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointerDown = {
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        moved: false,
        sphere: this.projectToSphere(e.clientX, e.clientY),
      };
    });
    this.canvas.addEventListener("pointermove", (e) => {
      const down = this.pointerDown;
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
      if (down.button === 0) {
        const current = this.projectToSphere(e.clientX, e.clientY);
        const arcballDelta = quaternionFromVectors(down.sphere, current);
        const movement = Math.hypot(dx, dy);
        if (movement > 0) {
          const rect = this.canvas.getBoundingClientRect();
          const diameter = Math.max(1, Math.min(rect.width, rect.height));
          const expectedAngle = movement * 2.4 / diameter;
          const arcballAngle = 2 * Math.acos(Math.max(-1, Math.min(1, Math.abs(arcballDelta[3]))));
          const rollingDelta = axisAngle(-dy / movement, dx / movement, 0, expectedAngle);
          const deadZoneBlend = Math.max(0, Math.min(1, (0.58 - arcballAngle / expectedAngle) / 0.42));
          const delta = blendQuaternion(arcballDelta, rollingDelta, deadZoneBlend);
          this.orientation = multiplyQuaternion(delta, this.orientation);
        }
        down.sphere = current;
      } else {
        const inv = 1 / Math.max(this.scale, 1e-12);
        const matrix = rotationMatrix(this.orientation);
        const viewX = -dx * inv, viewY = dy * inv;
        this.target[0] += matrix[0] * viewX + matrix[1] * viewY;
        this.target[1] += matrix[3] * viewX + matrix[4] * viewY;
        this.target[2] += matrix[6] * viewX + matrix[7] * viewY;
      }
      down.x = e.clientX; down.y = e.clientY; this.draw();
    });
    this.canvas.addEventListener("pointerup", (e) => { const down = this.pointerDown; this.pointerDown = null; if (down && !down.moved && down.button === 0) this.pick(e.clientX, e.clientY, true); });
    this.canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.scale *= Math.exp(-e.deltaY * 0.0015); this.scale = Math.max(1e-12, Math.min(1e12, this.scale)); this.draw(); }, { passive: false });
  }

  private projectToSphere(clientX: number, clientY: number): [number, number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const diameter = Math.max(1, Math.min(rect.width, rect.height));
    let x = (2 * (clientX - rect.left) - rect.width) / diameter;
    let y = (rect.height - 2 * (clientY - rect.top)) / diameter;
    const lengthSquared = x * x + y * y;
    const z = lengthSquared <= 0.5
      ? Math.sqrt(1 - lengthSquared)
      : 0.5 / Math.sqrt(lengthSquared);
    const length = Math.hypot(x, y, z) || 1;
    x /= length; y /= length;
    return [x, y, z / length];
  }

  private resize() {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.resizeObserver.disconnect();
    this.chunks.forEach((chunk) => this.gl.deleteBuffer(chunk.buffer));
    this.gl.deleteTexture(this.pickTexture); this.gl.deleteRenderbuffer(this.pickDepth); this.gl.deleteFramebuffer(this.pickFramebuffer);
    this.gl.deleteProgram(this.renderProgram); this.gl.deleteProgram(this.pickProgram);
  }
}

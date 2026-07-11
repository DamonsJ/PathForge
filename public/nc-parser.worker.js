const AXIS = /([XYZ])\s*=?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gi;

self.onmessage = async (event) => {
  const { file, fileName } = event.data;
  try {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const runPass = async (pass, onPoint) => {
      const reader = file.stream().getReader(), decoder = new TextDecoder();
      let pending = "", bytes = 0, sourceLines = 0, current = [0, 0, 0], points = 0;
      const parseLine = (raw) => {
        sourceLines++;
        const line = raw.replace(/\([^)]*\)/g, "").split(";")[0];
        AXIS.lastIndex = 0;
        let match, hasAxis = false;
        const next = current.slice();
        while ((match = AXIS.exec(line))) {
          const letter = match[1].toUpperCase();
          const axis = letter === "X" ? 0 : letter === "Y" ? 1 : 2;
          const value = Number(match[2]);
          if (Number.isFinite(value)) { next[axis] = value; hasAxis = true; }
        }
        if (!hasAxis) return;
        current = next;
        onPoint(next, sourceLines, points++);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
        for (const line of lines) parseLine(line);
        self.postMessage({ type: "progress", value: (pass - 1) * 0.5 + Math.min(0.49, bytes / Math.max(file.size, 1) * 0.49) });
      }
      pending += decoder.decode(); if (pending) parseLine(pending);
      return { points, sourceLines };
    };
    const first = await runPass(1, (point) => {
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]); }
    });
    if (!first.points) throw new Error("没有找到包含 X、Y 或 Z 坐标的有效行。");
    const center = min.map((value, i) => value + (max[i] - value) / 2);
    const positions = new Float32Array(first.points * 3), lines = new Uint32Array(first.points);
    const second = await runPass(2, (point, lineNumber, index) => {
      positions[index * 3] = point[0] - center[0]; positions[index * 3 + 1] = point[1] - center[1]; positions[index * 3 + 2] = point[2] - center[2]; lines[index] = lineNumber;
    });
    self.postMessage({
      type: "done", fileName, sourceLines: second.sourceLines, center,
      bounds: { min: min.map((v, i) => v - center[i]), max: max.map((v, i) => v - center[i]) },
      positions: positions.buffer, lineNumbers: lines.buffer,
    }, [positions.buffer, lines.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "文件解析失败" });
  }
};

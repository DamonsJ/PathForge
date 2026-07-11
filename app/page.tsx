"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NCWebGLRenderer, type PointSelection } from "../lib/nc-renderer";

type NCData = {
  positions: Float32Array;
  lineNumbers: Uint32Array;
  center: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  fileName: string;
  sourceLines: number;
};

type WorkerResult = Omit<NCData, "positions" | "lineNumbers"> & {
  positions: ArrayBuffer;
  lineNumbers: ArrayBuffer;
};

const ROW_HEIGHT = 42;

function fmt(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 8,
  });
}

function calculateBounds(positions: Float32Array): NCData["bounds"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[offset + axis]);
      max[axis] = Math.max(max[axis], positions[offset + axis]);
    }
  }
  return { min, max };
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gizmoRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<NCWebGLRenderer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [data, setData] = useState<NCData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<PointSelection | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [loading, setLoading] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [draggingFile, setDraggingFile] = useState(false);
  const [showPath, setShowPath] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const [pointSize, setPointSize] = useState(5);
  const [simulationIndex, setSimulationIndex] = useState<number | null>(null);
  const [playDirection, setPlayDirection] = useState<-1 | 0 | 1>(0);
  const [simulationSpeed, setSimulationSpeed] = useState(50);
  const [error, setError] = useState<string | null>(null);

  const applyData = useCallback((next: NCData) => {
    setData(next);
    setSelected(null);
    setSimulationIndex(null);
    setPlayDirection(0);
    setScrollTop(0);
    setError(null);
    rendererRef.current?.setData(next.positions, next.bounds);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const renderer = new NCWebGLRenderer(canvasRef.current, {
        onPick: (point) => {
          setSelected(point?.index ?? null);
          if (point && listRef.current) {
            listRef.current.scrollTop = Math.max(0, point.index * ROW_HEIGHT - listRef.current.clientHeight / 2);
          }
        },
        onHover: setHovered,
        onAxesChange: (axes) => {
          const gizmo = gizmoRef.current;
          if (!gizmo) return;
          for (const name of ["x", "y", "z"] as const) {
            const [x, y] = axes[name];
            const angle = Math.atan2(y, x);
            const length = Math.max(0.18, Math.hypot(x, y));
            const line = gizmo.querySelector<HTMLElement>(`.axis-line-${name}`);
            const label = line?.querySelector<HTMLElement>("span");
            if (line) line.style.transform = `rotate(${angle}rad) scaleX(${length})`;
            if (label) label.style.transform = `rotate(${-angle}rad) scaleX(${1 / length})`;
          }
        },
      });
      rendererRef.current = renderer;
      return () => renderer.dispose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法初始化 WebGL2");
    }
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => setViewportHeight(list.clientHeight));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => rendererRef.current?.setOptions({ showPath, showPoints, pointSize }), [showPath, showPoints, pointSize]);

  const pointCount = data ? data.positions.length / 3 : 0;

  useEffect(() => {
    rendererRef.current?.setSimulationIndex(simulationIndex);
    if (simulationIndex != null) setSelected(simulationIndex);
  }, [simulationIndex]);

  useEffect(() => {
    if (playDirection === 0 || pointCount === 0) return;
    const direction = playDirection;
    const timer = window.setInterval(() => {
      setSimulationIndex((previous) => {
        const current = previous ?? (direction > 0 ? 0 : pointCount - 1);
        const amount = Math.max(1, Math.round(simulationSpeed / 10));
        const next = Math.max(0, Math.min(pointCount - 1, current + direction * amount));
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playDirection, pointCount, simulationSpeed]);

  useEffect(() => {
    if (simulationIndex == null || playDirection === 0) return;
    if ((playDirection < 0 && simulationIndex === 0) || (playDirection > 0 && simulationIndex === pointCount - 1)) {
      setPlayDirection(0);
    }
  }, [simulationIndex, playDirection, pointCount]);

  const loadFile = useCallback((file: File) => {
    workerRef.current?.terminate();
    const worker = new Worker("/nc-parser.worker.js");
    workerRef.current = worker;
    setLoading(file.name);
    setProgress(0);
    setError(null);
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "progress") {
        setProgress(event.data.value);
        return;
      }
      if (event.data.type === "error") {
        setError(event.data.message);
        setLoading(null);
        return;
      }
      const result = event.data as WorkerResult & { type: "done" };
      applyData({
        ...result,
        positions: new Float32Array(result.positions),
        lineNumbers: new Uint32Array(result.lineNumbers),
      });
      setLoading(null);
      worker.terminate();
    };
    worker.onerror = () => {
      setError("文件解析失败，请检查 NC 文件格式。");
      setLoading(null);
    };
    worker.postMessage({ file, fileName: file.name });
  }, [applyData]);

  const selectRow = (index: number) => {
    setSelected(index);
    if (simulationIndex != null) setSimulationIndex(index);
    rendererRef.current?.selectPoint(index);
  };

  const stepSimulation = (direction: -1 | 1) => {
    if (pointCount === 0) return;
    setPlayDirection(0);
    setSimulationIndex((previous) => {
      const current = previous ?? selected ?? (direction > 0 ? -1 : pointCount);
      return Math.max(0, Math.min(pointCount - 1, current + direction));
    });
  };

  const playSimulation = (direction: -1 | 1) => {
    if (pointCount === 0) return;
    setSimulationIndex((previous) => previous ?? selected ?? (direction > 0 ? 0 : pointCount - 1));
    setPlayDirection(direction);
  };

  const trimPoints = (side: "before" | "after") => {
    if (!data || selected == null) return;
    const positions = side === "before"
      ? data.positions.slice(selected * 3)
      : data.positions.slice(0, (selected + 1) * 3);
    const lineNumbers = side === "before"
      ? data.lineNumbers.slice(selected)
      : data.lineNumbers.slice(0, selected + 1);
    const next: NCData = {
      ...data,
      positions,
      lineNumbers,
      bounds: calculateBounds(positions),
    };
    setData(next);
    setSelected(null);
    setSimulationIndex(null);
    setPlayDirection(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    rendererRef.current?.setSimulationIndex(null);
    rendererRef.current?.setData(next.positions, next.bounds);
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const end = Math.min(pointCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);
  const rows = [];
  for (let i = start; i < end; i++) {
    const x = data!.center[0] + data!.positions[i * 3];
    const y = data!.center[1] + data!.positions[i * 3 + 1];
    const z = data!.center[2] + data!.positions[i * 3 + 2];
    rows.push(
      <button
        type="button"
        className={`point-row ${selected === i ? "selected" : ""}`}
        style={{ transform: `translateY(${i * ROW_HEIGHT}px)` }}
        key={i}
        onClick={() => selectRow(i)}
        aria-label={`定位到第 ${data!.lineNumbers[i]} 行`}
      >
        <span className="row-index">{String(i + 1).padStart(6, "0")}</span>
        <span className="row-coord"><b>X</b>{fmt(x)} <b>Y</b>{fmt(y)} <b>Z</b>{fmt(z)}</span>
        <span className="row-line">L{data!.lineNumbers[i]}</span>
      </button>,
    );
  }

  const selectedCoords = selected != null && data ? [0, 1, 2].map((axis) => data.center[axis] + data.positions[selected * 3 + axis]) : null;

  return (
    <main
      className="app-shell"
      onDragEnter={(event) => { event.preventDefault(); dragDepth.current++; setDraggingFile(true); }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDraggingFile(false); }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault(); dragDepth.current = 0; setDraggingFile(false);
        const file = event.dataTransfer.files[0]; if (file) loadFile(file);
      }}
    >
      <header className="topbar">
        <div className="brand"><span className="brand-mark">NC</span><div><strong>PATHFORGE</strong><small>GPU PATH INSPECTOR</small></div></div>
        <div className="file-meta"><span className="status-dot" /> <strong>{data?.fileName ?? "未加载"}</strong><span>{pointCount.toLocaleString()} 点</span><span>{data?.sourceLines.toLocaleString()} 行</span></div>
        <div className="toolbar">
          <button type="button" onClick={() => rendererRef.current?.setView("top")} title="俯视图">TOP</button>
          <button type="button" onClick={() => rendererRef.current?.setView("bottom")} title="仰视图">BOTTOM</button>
          <button type="button" onClick={() => rendererRef.current?.setView("front")} title="前视图">FRONT</button>
          <button type="button" onClick={() => rendererRef.current?.setView("back")} title="后视图">BACK</button>
          <button type="button" onClick={() => rendererRef.current?.setView("left")} title="左视图">LEFT</button>
          <button type="button" onClick={() => rendererRef.current?.setView("right")} title="右视图">RIGHT</button>
          <button type="button" onClick={() => rendererRef.current?.setView("iso")} title="等轴测">ISO</button>
          <button type="button" className="icon-button" onClick={() => rendererRef.current?.fit()} title="显示全部">⌗</button>
          <button type="button" className="open-button" onClick={() => fileInputRef.current?.click()}>打开 NC 文件</button>
          <input ref={fileInputRef} hidden type="file" accept=".nc,.tap,.gcode,.txt,.cnc" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadFile(file); event.target.value = ""; }} />
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel-heading"><div><small>POINT SEQUENCE</small><h1>路径点</h1></div><span>{pointCount.toLocaleString()}</span></div>
          <div className="column-head"><span>序号 / 坐标</span><span>源行</span></div>
          <div className="point-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
            <div className="point-list-spacer" style={{ height: pointCount * ROW_HEIGHT }}>{rows}</div>
          </div>
          <div className="sidebar-footer">
            <span>虚拟列表</span><span>仅渲染 {Math.max(0, end - start)} 行</span>
          </div>
        </aside>

        <section className="viewport">
          <canvas ref={canvasRef} aria-label="NC 三维路径视图" />
          <div className="view-badge"><i /> WEBGL 2.0 <span>GPU</span></div>
          <div className="view-controls">
            <label><input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} /> 路径</label>
            <label><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> 点</label>
            <label className="size-control">点大小 <input type="range" min="1" max="9" value={pointSize} onChange={(e) => setPointSize(Number(e.target.value))} /></label>
          </div>
          <div className="axis-gizmo" ref={gizmoRef} aria-label="当前视角坐标轴">
            <i className="axis-line axis-line-x"><span>X</span></i>
            <i className="axis-line axis-line-y"><span>Y</span></i>
            <i className="axis-line axis-line-z"><span>Z</span></i>
            <b className="axis-origin" />
          </div>
          <div className="interaction-help"><span>左键拖动 <b>轨迹球旋转</b></span><span>右键 / 中键 <b>平移</b></span><span>滚轮 <b>缩放</b></span><span>点击 <b>拾取</b></span></div>
          <div className="simulation-controls" aria-label="路径模拟控制">
            <button type="button" onClick={() => stepSimulation(-1)} disabled={pointCount === 0} title="上一个点" aria-label="上一个点">|◀</button>
            <button type="button" className={playDirection === -1 ? "active" : ""} onClick={() => playSimulation(-1)} disabled={pointCount === 0} title="向后模拟" aria-label="向后模拟">◀</button>
            <button type="button" className={playDirection === 0 && simulationIndex != null ? "active" : ""} onClick={() => setPlayDirection(0)} disabled={simulationIndex == null} title="暂停" aria-label="暂停">Ⅱ</button>
            <button type="button" className={playDirection === 1 ? "active" : ""} onClick={() => playSimulation(1)} disabled={pointCount === 0} title="向前模拟" aria-label="向前模拟">▶</button>
            <button type="button" onClick={() => stepSimulation(1)} disabled={pointCount === 0} title="下一个点" aria-label="下一个点">▶|</button>
            <span className="simulation-position">{simulationIndex == null ? "未开始" : `${(simulationIndex + 1).toLocaleString()} / ${pointCount.toLocaleString()}`}</span>
            <label>速度 <input type="range" min="10" max="2000" step="10" value={simulationSpeed} onChange={(event) => setSimulationSpeed(Number(event.target.value))} /><b>{simulationSpeed} 点/秒</b></label>
            <button type="button" className="stop-button" onClick={() => { setPlayDirection(0); setSimulationIndex(null); setSelected(null); }} disabled={simulationIndex == null} title="结束模拟" aria-label="结束模拟">■</button>
          </div>
          {selectedCoords && <div className="selection-card">
            <small>SELECTED POINT · #{selected! + 1}</small>
            <strong>源文件 L{data!.lineNumbers[selected!]}</strong>
            <div className="selection-coordinates"><span>X {fmt(selectedCoords[0])}</span><span>Y {fmt(selectedCoords[1])}</span><span>Z {fmt(selectedCoords[2])}</span></div>
            <div className="selection-actions">
              <button type="button" onClick={() => trimPoints("before")} disabled={selected === 0} title="保留当前点，删除它之前的所有点">删除之前</button>
              <button type="button" onClick={() => trimPoints("after")} disabled={selected === pointCount - 1} title="保留当前点，删除它之后的所有点">删除之后</button>
            </div>
            <button type="button" className="close-button" aria-label="关闭选中点信息" onClick={() => { setSelected(null); rendererRef.current?.clearSelection(); }}>×</button>
          </div>}
          {hovered && selected == null && <div className="hover-hint">点 #{hovered.index + 1}</div>}
          {loading && <div className="loading-card"><div className="spinner" /><div><strong>正在解析 {loading}</strong><span>已处理 {Math.round(progress * 100)}%</span></div><div className="progress"><i style={{ width: `${progress * 100}%` }} /></div></div>}
          {error && <div className="error-card"><strong>无法继续</strong><span>{error}</span><button type="button" onClick={() => setError(null)}>关闭</button></div>}
        </section>
      </section>
      <footer className="statusbar"><span><i className="ok-dot" /> READY</span><span>范围 X {fmt(data?.bounds.min[0] ?? 0)} — {fmt(data?.bounds.max[0] ?? 0)}</span><span>Y {fmt(data?.bounds.min[1] ?? 0)} — {fmt(data?.bounds.max[1] ?? 0)}</span><span>Z {fmt(data?.bounds.min[2] ?? 0)} — {fmt(data?.bounds.max[2] ?? 0)}</span><span className="status-right">中心已做高精度偏移</span></footer>
      {draggingFile && <div className="drop-overlay"><div><span>＋</span><strong>释放以载入 NC 文件</strong><small>支持 .nc · .tap · .gcode · .txt</small></div></div>}
    </main>
  );
}

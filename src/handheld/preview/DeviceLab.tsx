import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCw, Smartphone } from "lucide-react";
import { DEVICE_PROFILES } from "./devices";
import type { NetworkScenario } from "../scanner/types";
import { browserPreviewConfig, DEFAULT_PREVIEW_CONFIG } from "../scanner/OmniPreviewSession";
import "./device-lab.css";

interface LabState {
  source: "simulation" | "omni"; connection: string; phase: string;
  seconds?: number; previewSeconds?: number; pointCount?: number;
  cloudStatus?: string; imageStatus?: string; detail?: string;
  channels?: { topic: string; schemaName: string }[];
}

export function DeviceLab() {
  const initial = new URLSearchParams(location.search);
  const [deviceId, setDeviceId] = useState(initial.get("device") || "pixel");
  const device = DEVICE_PROFILES.find(item => item.id === deviceId) ?? DEVICE_PROFILES[2];
  const [landscape, setLandscape] = useState(initial.get("landscape") === "1");
  const [autoRotate, setAutoRotate] = useState(false);
  const [safeArea, setSafeArea] = useState(true);
  const [fontScale, setFontScale] = useState(1);
  const [pixelRatio, setPixelRatio] = useState(1.5);
  const [network, setNetwork] = useState<NetworkScenario>("normal");
  const [mode, setMode] = useState(initial.get("mode") === "demo" ? "demo" : "live");
  const [connectionConfig, setConnectionConfig] = useState(() => browserPreviewConfig(DEFAULT_PREVIEW_CONFIG));
  const [ready, setReady] = useState(0);
  const [state, setState] = useState<LabState | null>(null);
  const [route, setRoute] = useState("scan");
  const [bounds, setBounds] = useState({ width: 1000, height: 850 });
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const width = landscape ? device.height : device.width;
  const height = landscape ? device.width : device.height;
  const scale = Math.min(1, Math.max(0.15, Math.min((bounds.width - 44) / width, (bounds.height - 44) / height)));
  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, location.origin);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setBounds(entry.contentRect));
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "omni-app:ready") setReady(value => value + 1);
      if (event.data?.type === "omni-app:state") setState(event.data);
      if (event.data?.type === "omni-app:route") {
        setRoute(event.data.route);
        if (autoRotate) setLandscape(event.data.route === "capture");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [autoRotate]);
  useEffect(() => {
    const insets = !safeArea ? { top: 0, right: 0, bottom: 0, left: 0 } : landscape
      ? { top: 0, right: device.insets.bottom, bottom: 0, left: device.insets.top } : device.insets;
    send({ type: "omni-lab:viewport", insets, fontScale, pixelRatio });
    const url = new URL(location.href);
    url.searchParams.set("device", device.id);
    url.searchParams.set("landscape", landscape ? "1" : "0");
    url.searchParams.set("mode", mode);
    history.replaceState(null, "", url);
  }, [device, landscape, safeArea, fontScale, pixelRatio, ready, mode]);
  useEffect(() => { send({ type: "omni-lab:network", network }); }, [network, ready]);

  return <main className="device-lab">
    <header className="lab-header"><div><Smartphone size={26} /><span><strong>OMNI Scan</strong><small>安卓界面调试台</small></span></div><a href={`./index.html?mode=${mode}`} target="_blank" rel="noreferrer">独立打开 App ↗</a></header>
    <aside className="lab-panel">
      <h1>设备预览</h1><p>调整尺寸，保留当前页面与视角。</p>
      <label>数据来源<select value={mode} onChange={event => { setMode(event.target.value); setState(null); }}><option value="live">真实 OMNI · 只订阅预览</option><option value="demo">模拟数据 · 流程演示</option></select></label>
      <label>安卓设备档位<select value={device.id} onChange={event => setDeviceId(event.target.value)}>{DEVICE_PROFILES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <div className="lab-actions"><button onClick={() => setLandscape(value => !value)}><RotateCw size={17} />旋转屏幕</button><button onClick={() => send({ type: "omni-lab:back" })}><ArrowLeft size={17} />返回键</button></div>
      <label className="lab-checkbox"><input type="checkbox" checked={autoRotate} onChange={event => { setAutoRotate(event.target.checked); if (event.target.checked) setLandscape(route === "capture"); }} />进入预览自动横屏</label>
      <label className="lab-checkbox"><input type="checkbox" checked={safeArea} onChange={event => setSafeArea(event.target.checked)} />状态栏 / 手势安全区</label>
      <label>字号压力档位<select value={fontScale} onChange={event => setFontScale(Number(event.target.value))}><option value={1}>默认 · 100%</option><option value={1.15}>较大 · 115%</option><option value={1.3}>大字 · 130%</option></select></label>
      <label>演示渲染像素比<select disabled={mode !== "demo"} value={pixelRatio} onChange={event => setPixelRatio(Number(event.target.value))}><option value={1}>1× · 低负载</option><option value={1.5}>1.5× · 均衡</option><option value={2}>2× · 高清</option></select></label>
      <label>模拟设备网络<select disabled={mode !== "demo"} value={network} onChange={event => setNetwork(event.target.value as NetworkScenario)}><option value="normal">正常连接</option><option value="slow">慢连接 · 5 秒</option><option value="offline">设备断线</option></select></label>
      {mode === "live" && <details><summary>开发连接配置</summary><label>WebSocket<input value={connectionConfig.wsUrl} onChange={event => setConnectionConfig({ ...connectionConfig, wsUrl: event.target.value })} /></label><label>点云 topic<input value={connectionConfig.pointCloudTopic} onChange={event => setConnectionConfig({ ...connectionConfig, pointCloudTopic: event.target.value })} /></label><button onClick={() => send({ type: "omni-lab:connect", config: connectionConfig })}>应用并连接</button></details>}
      <section className="lab-status" aria-label="运行状态"><h2>当前状态</h2><dl>
        <div><dt>逻辑视口</dt><dd>{width} × {height}</dd></div><div><dt>展示缩放</dt><dd>{Math.round(scale * 100)}%</dd></div>
        <div><dt>页面</dt><dd>{route}</dd></div><div><dt>设备连接</dt><dd>{state?.connection ?? "等待页面"}</dd></div>
        <div><dt>采集状态</dt><dd>{state?.phase ?? "—"}</dd></div>{mode === "demo" ? <div><dt>采集 / 预览</dt><dd>{state?.seconds ?? 0}s / {state?.previewSeconds ?? 0}s</dd></div> : <><div><dt>当前帧点数</dt><dd>{state?.pointCount ?? 0}</dd></div><div><dt>点云 / 图像</dt><dd>{state?.cloudStatus ?? "waiting"} / {state?.imageStatus ?? "waiting"}</dd></div></>}
      </dl></section>
      {mode === "live" && <details className="lab-diagnostics"><summary>开发诊断（仅调试台）</summary><pre>{JSON.stringify(state, null, 2)}</pre></details>}
      <p className="lab-note">型号名称仅表示典型布局档位。这里模拟尺寸、安全区和业务断线；Android 系统、WebView、GPU、系统字体缩放需在模拟器或真机另行验证。</p>
    </aside>
    <div className="lab-stage" ref={stage}>
      <div className="lab-frame-space" style={{ width: width * scale, height: height * scale }}>
        <div className="lab-device" style={{ width, height, transform: `scale(${scale})` }}>
          <iframe ref={frame} title="OMNI Scan 安卓 App" src={`./index.html?lab=1&mode=${mode}`} />
        </div>
      </div>
    </div>
    <footer className="lab-footer">浏览器热更新 · {mode === "demo" ? "模拟数据" : "真实 OMNI 预览"} · {device.label} · {landscape ? "横屏" : "竖屏"}</footer>
  </main>;
}

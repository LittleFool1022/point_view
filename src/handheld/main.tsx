import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RotateCw, Smartphone } from "lucide-react";
import { HandheldDemo } from "./HandheldDemo";
import "./handheld.css";
import "./mobile-preview.css";
import "./design-theme.css";
import "./live-omni.css";

function MobileApp() {
  useEffect(() => {
    if (window.parent === window) return;
    // 本地 HTML 的 origin 为 "null"；消息仅包含演示界面方向，不包含用户数据。
    const announce = () => window.parent.postMessage({ type: "omni-mobile-route", capture: location.hash === "#/capture" }, location.origin === "null" ? "*" : location.origin);
    announce();
    window.addEventListener("hashchange", announce);
    return () => window.removeEventListener("hashchange", announce);
  }, []);
  return <HandheldDemo />;
}

function MobilePreview() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [landscape, setLandscape] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 960px)").matches);
  const embedded = document.documentElement.dataset.omniEmbedded === "true" || new URLSearchParams(location.search).get("app") === "1";
  const [standaloneDocument] = useState(() => {
    if (embedded) return undefined;
    const code = document.getElementById("omni-inline-runtime")?.textContent;
    const css = document.getElementById("omni-inline-style")?.textContent;
    if (!code || !css) return undefined;
    // 单文件版直接内嵌手机页面，避免 file:// 下再次读取文件或请求局域网资源。
    return `<!doctype html><html lang="zh-CN" data-omni-embedded="true"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>OMNI Scan 手机演示</title><style>${css}</style></head><body><div id="root"></div><script>${code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  });
  useEffect(() => {
    const media = window.matchMedia("(min-width: 960px)");
    const changed = () => setWide(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const expectedOrigin = location.protocol === "file:" ? "null" : location.origin;
      if (event.origin !== expectedOrigin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "omni-mobile-route") setLandscape(event.data.capture === true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  if (!wide || embedded) return <MobileApp />;
  return <main className="mobile-preview-stage">
    <header className="mobile-preview-header">
      <div><Smartphone size={22} /><span><strong>OMNI Scan</strong><small>手机 App · 交互演示</small></span></div>
      <button onClick={() => setLandscape(value => !value)}><RotateCw size={17} />切换{landscape ? "竖屏" : "横屏"}</button>
    </header>
    <div className={`mobile-device-frame ${landscape ? "landscape" : ""}`}>
      <iframe ref={frame} title="OMNI Scan 手机 App 演示" src={standaloneDocument ? undefined : `${location.pathname}?app=1${location.hash}`} srcDoc={standaloneDocument} />
    </div>
    <p className="mobile-preview-caption">{landscape ? "横屏扫描视图" : "竖屏手机界面"}<span>所有设备与扫描数据均为模拟</span></p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><MobilePreview /></StrictMode>);

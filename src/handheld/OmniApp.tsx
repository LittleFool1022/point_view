import { useEffect } from "react";
import { HandheldDemo } from "./HandheldDemo";
import { LiveOmniApp } from "./LiveOmniApp";
import { isLabMessage, postLabMessage } from "./preview/protocol";
import "./handheld.css";
import "./design-theme.css";
import "./omni-app.css";
import "./live-omni.css";

export function OmniApp() {
  const demo = new URLSearchParams(location.search).get("mode") === "demo";
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!isLabMessage(event) || event.data.type !== "omni-lab:viewport") return;
      const { insets, fontScale, pixelRatio } = event.data;
      const root = document.documentElement;
      for (const edge of ["top", "right", "bottom", "left"]) {
        const value = insets?.[edge];
        if (typeof value === "number" && Number.isFinite(value)) root.style.setProperty(`--omni-safe-${edge}`, `${Math.max(0, Math.min(80, value))}px`);
      }
      if ([1, 1.15, 1.3].includes(fontScale)) root.style.setProperty("--omni-font-scale", `${fontScale}`);
      if ([1, 1.5, 2].includes(pixelRatio)) {
        root.dataset.omniPixelRatio = `${pixelRatio}`;
        window.dispatchEvent(new Event("omni:render-budget"));
      }
    };
    const announce = () => postLabMessage({ type: "omni-app:route", route: location.hash.slice(2) || "scan" });
    window.addEventListener("message", receive);
    window.addEventListener("hashchange", announce);
    postLabMessage({ type: "omni-app:ready" }); announce();
    return () => { window.removeEventListener("message", receive); window.removeEventListener("hashchange", announce); };
  }, []);

  return <><div id="omni-safe-viewport">{demo ? <HandheldDemo /> : <LiveOmniApp />}</div>{demo && <span className="omni-demo-marker">模拟数据</span>}</>;
}

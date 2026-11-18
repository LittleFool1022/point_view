import { lazy, Suspense, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, FolderOpen, LoaderCircle, Pause, Play, PlugZap } from "lucide-react";

const SpatialSculpture = lazy(() => import("./SpatialSculpture").then((module) => ({ default: module.SpatialSculpture })));

interface Props {
  importing: boolean;
  busy: boolean;
  onImport(): void;
  onConnect(): void;
  onEnter(): void;
  onProjects(): void;
}

export function SpatialWelcome({ importing, busy, onImport, onConnect, onEnter, onProjects }: Props) {
  const [paused, setPaused] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  return <section className="spatial-welcome" aria-label="空间概览">
    <div className="welcome-index"><span>GUANYAO — SPATIAL COMPUTING</span><span>从物理世界，到数字空间 <ArrowDownRight size={15} /></span></div>
    <div className="welcome-composition">
      <div className="welcome-copy">
        <div className="welcome-kicker"><span className="edition-mark" /> 空间的另一种存在方式</div>
        <h1>让真实，<br /><span>超越所见。</span></h1>
        <p className="welcome-description">以点为起点，重新认识空间。<br />采集、探索与重构，让每一处细节清晰可见。</p>
        <div className="welcome-actions">
          <button className="welcome-import" disabled={busy} aria-busy={importing} onClick={onImport}>
            {importing ? <LoaderCircle className="button-spinner" size={18} /> : <FolderOpen size={18} />}
            {importing ? "正在导入" : "导入空间数据"}<ArrowUpRight size={19} />
          </button>
          <button className="welcome-connect" onClick={onConnect}><PlugZap size={17} />连接 Omni<ArrowRight size={17} /></button>
        </div>
        <span className="welcome-formats">PCD / PLY / LAS / LAZ / MCAP</span>
      </div>
      <figure className="welcome-artwork">
        <span className="sculpture-index">物质 / 数字<br /><b>01 — CONTINUUM</b></span>
        <Suspense fallback={<div className="sculpture-loading" role="status">正在构建空间形体…</div>}><SpatialSculpture paused={paused} /></Suspense>
        <figcaption><span>连续的形体，离散的世界。</span><button onClick={() => setPaused((value) => !value)} aria-pressed={paused} aria-label={paused ? "播放雕塑动效" : "暂停雕塑动效"}>{paused ? <Play size={13} /> : <Pause size={13} />}<span>{paused ? "播放动效" : "暂停动效"}</span></button></figcaption>
      </figure>
      <div className="welcome-wordmark" aria-hidden="true">POINT VIEW</div>
    </div>
    <div className="welcome-paths" aria-label="快速开始">
      <button onClick={onEnter}><span className="path-number">01 / EXPLORE</span><span className="path-title">进入空间工作台<ArrowUpRight /></span><span className="path-description">自由探索 · 真彩点云 · 精准编辑</span></button>
      <button onClick={onConnect}><span className="path-number">02 / CAPTURE</span><span className="path-title">与真实世界同步<ArrowUpRight /></span><span className="path-description">连接 Omni · 多视角采集 · 实时呈现</span></button>
      <button onClick={onProjects}><span className="path-number">03 / ARCHIVE</span><span className="path-title">继续你的空间工程<ArrowUpRight /></span><span className="path-description">本地快照 · 编辑记录 · 成果交付</span></button>
    </div>
    <footer className="welcome-footer"><span>观曜科技 <i /> POINT VIEW</span><span>现实的精度，想象的自由。</span><span>空间数据工作室</span></footer>
  </section>;
}

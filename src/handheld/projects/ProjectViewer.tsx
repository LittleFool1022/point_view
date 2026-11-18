import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Crosshair, Download, Film, LoaderCircle, Pause, Play, X } from "lucide-react";
import { PointCloudCanvas, type CloudFocusRequest } from "../../components/PointCloudCanvas";
import type { PointCloudData } from "../../domain/types";
import {
  cacheProject,
  cachedProject,
  decodeProject,
  fetchProject,
  projectVideoUrl,
  resolveProjectVideo,
  subscribeProjectDescriptors,
  type DeviceProject,
} from "./ProjectFiles";
import { CloudUploadControls, type CloudUploadControlsProps } from "../cloud/CloudUploadControls";
import "./project-viewer.css";

const selected = new Set<number>();
const noop = () => {};
const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const formatClipTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
};
function focusCloud(cloud: PointCloudData): CloudFocusRequest {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let point = 0; point < cloud.visible.length; point++) {
    if (!cloud.visible[point]) continue;
    for (let axis = 0; axis < 3; axis++) {
      const value = cloud.positions[point * 3 + axis]!;
      min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
    }
  }
  if (!min.every(Number.isFinite)) throw new Error("点云没有有效坐标");
  return { token: performance.now(), fit: true,
    center: min.map((value, axis) => (value + max[axis]!) / 2) as [number, number, number],
    radius: Math.max(0.5, Math.hypot(...min.map((value, axis) => max[axis]! - value)) / 2) };
}

export function ProjectViewer({ project, endpoint, online, onClose, onUpdate, cloudControls }: {
  project: DeviceProject; endpoint: string; online: boolean; onClose(): void; onUpdate(project: DeviceProject): void;
  cloudControls?: Omit<CloudUploadControlsProps, "project">;
}) {
  const [cloud, setCloud] = useState<PointCloudData | null>(null);
  const [focus, setFocus] = useState<CloudFocusRequest>();
  const [progress, setProgress] = useState(0);
  const [transfer, setTransfer] = useState<{ received: number; total: number; speed: number }>();
  const [busy, setBusy] = useState(true);
  const [phase, setPhase] = useState<"opening" | "downloading" | "reading">("opening");
  const [message, setMessage] = useState("正在打开项目…");
  const [offline, setOffline] = useState(project.local);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [density, setDensity] = useState("1000000");
  const [fullAvailable, setFullAvailable] = useState(false);
  const [, setDescriptorVersion] = useState(0);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoError, setVideoError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const skipCachedFull = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  // 已读文件保留到查看器关闭；切换显示点量不重复传输，也不依赖缓存写入成功。
  const loadedFile = useRef<{ blob: Blob; full: boolean } | undefined>(undefined);

  useEffect(() => subscribeProjectDescriptors(() => setDescriptorVersion(value => value + 1)), []);

  const videoInfo = resolveProjectVideo(project);
  const isPartialVideo = videoInfo.videoState === "partial";
  const canPlayVideo =
    (videoInfo.videoState === "complete" || isPartialVideo) &&
    videoInfo.video !== null;
  const effectiveDuration = videoDuration > 0
    ? videoDuration
    : Math.max(0, videoInfo.video?.durationSourceS ?? 0);
  const videoSrc = canPlayVideo ? projectVideoUrl(endpoint, project.id) : "";

  useEffect(() => {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    setVideoOpen(false);
    setVideoPlaying(false);
    setVideoTime(0);
    setVideoDuration(0);
    setVideoError("");
  }, [project.id, canPlayVideo]);

  useEffect(() => {
    if (!online && videoPlaying) {
      videoRef.current?.pause();
      setVideoPlaying(false);
    }
  }, [online, videoPlaying]);

  useEffect(() => {
    const abort = new AbortController(); request.current = abort;
    const run = async () => {
      setBusy(true); setProgress(0); setTransfer(undefined); setPhase("opening"); setMessage("正在打开项目…");
      try {
        let full: Blob | undefined = selectedFile || (loadedFile.current?.full ? loadedFile.current.blob : undefined) || (skipCachedFull.current ? undefined : await cachedProject(project.id));
        let blob = full || (!downloadRequested ? loadedFile.current?.blob || await cachedProject(project.id, true) : undefined);
        if (!blob) {
          if (!online) throw new Error("设备未连接，可导入该项目的本机 PCD 文件");
          setPhase(downloadRequested ? "downloading" : "opening");
          setMessage(downloadRequested ? "正在下载完整点云…" : "正在加载点云预览…");
          const started = performance.now();
          // 预览失败要让用户决定是否下载，不能自动发起大文件传输。
          blob = await fetchProject(endpoint, project.id, !downloadRequested, abort.signal, (percent, received = 0, total = 0) => {
            setProgress(percent); setTransfer({ received, total, speed: received / Math.max(0.1, (performance.now() - started) / 1000) });
          });
          if (downloadRequested) full = blob;
        }
        if (abort.signal.aborted) return;
        setPhase("reading"); setMessage("正在校验并读取点云…");
        const decoded = await decodeProject(blob, project.id, full ? project.sha256 : undefined, abort.signal,
          density === "all" ? null : Number(density));
        if (abort.signal.aborted) return;
        loadedFile.current = { blob, full: !!full };
        setFullAvailable(!!full); setFocus(focusCloud(decoded.cloud)); setCloud(decoded.cloud);
        try {
          await cacheProject(project.id, blob, !full);
          if (abort.signal.aborted) return;
          setOffline(!!full);
          onUpdate({ ...project, local: !!full, previewCached: true,
            sha256: full ? decoded.sha256 : project.sha256,
            fileName: selectedFile?.name || project.fileName, bytes: full ? blob.size : project.bytes,
            sourcePoints: full ? decoded.cloud.sourcePointCount : project.sourcePoints,
            points: full ? `${((decoded.cloud.sourcePointCount || 0) / 10000).toFixed(1)} 万` : project.points });
          setMessage(full ? "完整点云已保存在此 App，可离线查看" : "当前为抽样预览；下载完整点云后可切换显示点量");
        } catch { setOffline(false); setMessage("点云已打开，但空间不足，未保存离线文件"); }
      } catch (error) {
        if (!abort.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "项目暂时无法打开");
          if (!loadedFile.current) { setOffline(false); setFullAvailable(false); }
        }
      } finally { if (!abort.signal.aborted) setBusy(false); }
    };
    void run();
    return () => { abort.abort(); if (request.current === abort) request.current = undefined; };
    // 网络状态变化只影响操作提示，不能中断或自动重启正在传输的文件。
  }, [project.id, endpoint, downloadRequested, retry, selectedFile, density]);

  useEffect(() => {
    if (project.local && !fullAvailable && !busy) setRetry(value => value + 1);
  }, [project.local]);

  const cancelDownload = () => {
    request.current?.abort(); setBusy(false); setTransfer(undefined);
    setMessage("下载已取消；再次下载将从头开始");
  };
  const download = () => {
    if (!online) { setMessage("请连接设备 Wi-Fi 后再下载完整点云"); return; }
    skipCachedFull.current = !loadedFile.current?.full;
    setBusy(true); setPhase("downloading"); setMessage("正在连接设备，准备下载…"); setProgress(0);
    setDownloadRequested(true); setRetry(value => value + 1);
  };
  const closeVideo = () => {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    setVideoPlaying(false);
    setVideoOpen(false);
  };
  const toggleVideoPlay = async () => {
    const element = videoRef.current;
    if (!element || !online || videoError) return;
    if (videoPlaying || !element.paused) {
      element.pause();
      setVideoPlaying(false);
      return;
    }
    try {
      setVideoError("");
      setVideoPlaying(true);
      const result = element.play?.();
      if (result && typeof result.then === "function") {
        await result;
      }
    } catch {
      setVideoPlaying(false);
      setVideoError("视频无法播放，请检查设备连接");
    }
  };
  const seekVideo = (nextSeconds: number) => {
    if (!Number.isFinite(nextSeconds) || nextSeconds < 0) return;
    const target = effectiveDuration > 0 ? Math.min(nextSeconds, effectiveDuration) : nextSeconds;
    setVideoTime(target);
    if (videoRef.current) {
      videoRef.current.currentTime = target;
    }
  };
  const transferText = busy && transfer && phase !== "reading"
    ? `已接收 ${megabytes(transfer.received)}${transfer.total ? ` / ${megabytes(transfer.total)} · ${progress}%` : ""} · ${megabytes(transfer.speed)}/s` : "";

  return <section className="project-viewer" aria-label="项目点云查看器" aria-busy={busy}>
    <header>
      <button className="icon-button" aria-label="关闭项目" onClick={onClose}><ArrowLeft size={21} /></button>
      <div><h1>{project.name}</h1><span>{fullAvailable && cloud ? `${((cloud.sourcePointCount || 0) / 10000).toFixed(1)} 万` : project.points}原始点{cloud ? ` · 已载入 ${(cloud.positions.length / 3 / 10000).toFixed(1)} 万点` : ""}</span></div>
    </header>
    <div className="project-cloud">
      <PointCloudCanvas cloud={cloud} colorMode="rgb" pointSize={0.025} selected={selected}
        pointBudget={cloud?.visible.length || 1}
        selectionEnabled={false} moveEnabled={false} showReferenceGuides={false}
        resetToken={0} focusRequest={focus} onTogglePoint={noop} onSelectPoints={noop} onMoveSelected={noop} onStats={noop} />
      {busy && <div className="project-loading"><LoaderCircle className="spin" size={28} /><p>{message}</p>
        {phase !== "reading" && <><progress aria-label="文件接收进度" max={100} value={progress || undefined} /><small>{transferText || "正在等待设备响应"}</small></>}
      </div>}
      {!busy && !cloud && <div className="project-loading"><p>暂无可显示的点云</p>
        <button className="primary" onClick={() => fileInput.current?.click()}>导入该项目 PCD</button>
        <button className="secondary" onClick={() => setRetry(value => value + 1)}>重新打开</button>
      </div>}
      {canPlayVideo && videoInfo.video && videoOpen && (
        <div className="project-video-panel" role="region" aria-label="通道行进视频播放器">
          <div className="project-video-header">
            <div>
              <strong>walkthrough.mp4</strong>
              <span>{megabytes(videoInfo.video.bytes)} · {Math.max(1, Math.round(videoInfo.video.durationSourceS))} 秒 · {videoInfo.video.frames} 帧{isPartialVideo ? " · 源帧存在间断，未通过质量校验" : ""}</span>
            </div>
            <button type="button" className="icon-button" aria-label="关闭行进视频" onClick={closeVideo}>
              <X size={18} />
            </button>
          </div>
          <div className="project-video-stage">
            <video
              ref={videoRef}
              className="project-video-element"
              src={videoSrc}
              controls
              playsInline
              preload="metadata"
              aria-label="通道行进视频画面"
              onLoadedMetadata={event => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) {
                  setVideoDuration(duration);
                }
                setVideoError("");
              }}
              onTimeUpdate={event => {
                setVideoTime(event.currentTarget.currentTime);
              }}
              onPlay={() => {
                setVideoPlaying(true);
                setVideoError("");
              }}
              onPause={() => {
                setVideoPlaying(false);
              }}
              onEnded={() => {
                setVideoPlaying(false);
              }}
              onError={() => {
                setVideoPlaying(false);
                setVideoError(online ? "视频加载失败，请重试或检查设备文件" : "设备未连接，无法播放通道行进视频");
              }}
            />
          </div>
          {(!online || videoError) && (
            <p className="project-video-error" role="alert">
              {videoError || "设备未连接，请连接设备 Wi-Fi 后播放通道行进视频"}
            </p>
          )}
          <div className="project-video-controls">
            <button
              type="button"
              className="secondary project-video-toggle"
              aria-label={videoPlaying ? "暂停视频" : "播放视频"}
              disabled={!online || Boolean(videoError)}
              onClick={() => void toggleVideoPlay()}
            >
              {videoPlaying ? <Pause size={16} /> : <Play size={16} />}
              {videoPlaying ? "暂停" : "播放"}
            </button>
            <input
              type="range"
              className="project-video-seek"
              aria-label="视频进度"
              min={0}
              max={effectiveDuration}
              step={0.1}
              value={Math.min(videoTime, effectiveDuration)}
              disabled={!online || Boolean(videoError) || effectiveDuration <= 0}
              onChange={event => seekVideo(Number(event.target.value))}
            />
            <span className="project-video-time">
              {formatClipTime(videoTime)} / {formatClipTime(effectiveDuration)}
            </span>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" accept=".pcd" hidden aria-label="选择项目 PCD 文件" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.name.toLowerCase().endsWith(".pcd")) setSelectedFile(file);
        else setMessage("请选择 PCD 点云文件");
      }} />
    </div>
    <footer>
      <span role="status">{message}</span>
      <div className="project-actions">
        <label className="project-density">显示点量
          <select aria-label="项目显示点量" value={fullAvailable ? density : "preview"} disabled={busy || !fullAvailable} onChange={event => setDensity(event.target.value)}>
            {!fullAvailable && <option value="preview">抽样预览</option>}
            <option value="1000000">100 万点</option><option value="3000000">300 万点</option><option value="all">全部点</option>
          </select>
        </label>
        <button className="icon-button" aria-label="项目视角复位" disabled={busy || !cloud} onClick={() => cloud && setFocus(focusCloud(cloud))}><Crosshair size={20} /></button>
        {canPlayVideo && (
          <button
            type="button"
            className={`secondary project-video-entry ${isPartialVideo ? "partial" : ""} ${videoOpen ? "active" : ""}`}
            aria-expanded={videoOpen}
            onClick={() => {
              if (videoOpen) closeVideo();
              else {
                setVideoError("");
                setVideoOpen(true);
              }
            }}
          >
            <Film size={18} />
            {isPartialVideo ? "行进视频（有源帧间断）" : "通道行进视频"}
          </button>
        )}
        {videoInfo.videoState === "invalid" && (
          <span className="project-video-status invalid" role="status">
            视频未完成
          </span>
        )}
        {busy && phase === "downloading"
          ? <button className="secondary" onClick={cancelDownload}>取消下载</button>
          : <button className="primary" disabled={busy || cloudControls?.busy || offline || !online} onClick={download}>
            {busy ? <LoaderCircle className="spin" size={18} /> : !offline && <Download size={18} />}
            {busy ? phase === "reading" ? "正在读取…" : "正在打开…" : offline ? "已可离线查看" : "下载完整点云"}
          </button>}
      </div>
      {cloudControls && !busy && <CloudUploadControls {...cloudControls} project={project} />}
      {!offline && !busy && <small>{!online ? "设备未连接；已有离线文件仍可打开" : `完整点云${project.bytes ? `约 ${megabytes(project.bytes)}，` : ""}保存在此 App，不会自动导出到系统下载目录。`}</small>}
    </footer>
  </section>;
}

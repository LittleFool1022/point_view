/** 调试指令只接收同源父窗口；独立 App 页面和原生壳不启用该入口。 */
export const inDeviceLab = () => window.parent !== window && new URLSearchParams(location.search).get("lab") === "1";
export function isLabMessage(event: MessageEvent): boolean {
  return inDeviceLab() && event.source === window.parent && event.origin === location.origin && !!event.data && typeof event.data === "object";
}
export function postLabMessage(message: Record<string, unknown>) {
  if (inDeviceLab()) window.parent.postMessage(message, location.origin);
}

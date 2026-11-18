import { useEffect, useState, useSyncExternalStore } from "react";
import { SimulatedScanner } from "./SimulatedScanner";
import { isLabMessage, postLabMessage } from "../preview/protocol";

export function useScanner() {
  const [scanner] = useState(() => new SimulatedScanner());
  const snapshot = useSyncExternalStore(scanner.subscribe, scanner.getSnapshot);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!isLabMessage(event) || event.data.type !== "omni-lab:network") return;
      if (["normal", "slow", "offline"].includes(event.data.network)) scanner.setNetwork(event.data.network);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [scanner]);
  useEffect(() => { postLabMessage({ type: "omni-app:state", ...snapshot }); }, [snapshot]);
  return { scanner, ...snapshot };
}

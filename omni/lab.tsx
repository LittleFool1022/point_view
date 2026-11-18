import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeviceLab } from "../src/handheld/preview/DeviceLab";

createRoot(document.getElementById("root")!).render(<StrictMode><DeviceLab /></StrictMode>);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OmniApp } from "../src/handheld/OmniApp";

createRoot(document.getElementById("root")!).render(<StrictMode><OmniApp /></StrictMode>);

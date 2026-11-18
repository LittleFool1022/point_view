import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zk.pointview",
  appName: "Point View",
  webDir: "dist",
  server: {
    androidScheme: "https",
    cleartext: true
  },
  android: {
    allowMixedContent: true,
    captureInput: true
  }
};

export default config;

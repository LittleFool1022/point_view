export function demoRoom(): ArrayBuffer {
  const rows: string[] = [];
  for (let z = .2; z <= 2.8; z += .2) {
    for (let x = 0; x <= 8; x += .05) rows.push(`${x} 0 ${z}`, `${x} 6 ${z}`);
    for (let y = 0; y <= 6; y += .05) rows.push(`0 ${y} ${z}`, `8 ${y} ${z}`);
  }
  const pcd = `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`;
  return new TextEncoder().encode(pcd).buffer as ArrayBuffer;
}

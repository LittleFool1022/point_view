export function gappedRoomPcd(): ArrayBuffer {
  const rows: string[] = [], angle = .23, cs = Math.cos(angle), sn = Math.sin(angle);
  const add = (x: number, y: number, z: number) => rows.push(`${x * cs - y * sn} ${x * sn + y * cs} ${z}`);
  for (let t = 0; t <= 8; t += .05) for (let z = 0; z <= 3; z += .1) { if (t < 3 || t > 4) add(t, 0, z); add(t, 6, z); }
  for (let t = 0; t <= 6; t += .05) for (let z = 0; z <= 3; z += .1) { add(0, t, z); add(8, t, z); }
  const pcd = `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`;
  return new TextEncoder().encode(pcd).buffer as ArrayBuffer;
}

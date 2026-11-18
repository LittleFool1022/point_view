import { useEffect, useRef } from "react";
import L, { type Map } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoPosition } from "../domain/types";

export function RtkMap({ position }: { position?: GeoPosition }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | undefined>(undefined);
  const markerRef = useRef<L.CircleMarker | undefined>(undefined);
  useEffect(() => {
    if (!hostRef.current) return;
    const center: L.LatLngExpression = position ? [position.latitude, position.longitude] : [31.2304, 121.4737];
    const map = L.map(hostRef.current, { attributionControl: false, zoomControl: true }).setView(center, position ? 18 : 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = undefined; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    const latLng: L.LatLngExpression = [position.latitude, position.longitude];
    if (!markerRef.current) markerRef.current = L.circleMarker(latLng, { radius: 7, color: "#38ff8b", fillColor: "#38ff8b", fillOpacity: 0.8, weight: 2 }).addTo(map);
    else markerRef.current.setLatLng(latLng);
    map.flyTo(latLng, Math.max(map.getZoom(), 17), { duration: 0.6 });
  }, [position]);
  return <div className="map-shell"><div ref={hostRef} className="map-canvas" />{!position && <div className="map-wait">等待 RTK 定位</div>}</div>;
}

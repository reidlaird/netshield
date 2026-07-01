import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

export type MapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  sublabel?: string;
  selected?: boolean;
};

export type RoutePoint = {
  hop: number;
  latitude: number;
  longitude: number;
  label: string;
  sublabel?: string;
  latency?: string;
};

function FlyToSelected({ point }: { point?: MapPoint }) {
  const map = useMap();
  const id = point?.id;
  const latitude = point?.latitude;
  const longitude = point?.longitude;
  useEffect(() => {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
    map.flyTo([latitude, longitude], Math.max(map.getZoom(), 5), { duration: 0.8 });
  }, [map, id, latitude, longitude]);
  return null;
}

function FitRoute({ points }: { points: RoutePoint[] }) {
  const map = useMap();
  const signature = points.map((point) => `${point.latitude},${point.longitude}`).join('|');
  useEffect(() => {
    if (points.length < 2) return;
    const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number]));
    map.flyToBounds(bounds, { padding: [40, 40], duration: 0.8, maxZoom: 8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, signature]);
  return null;
}

// Hop 1 sits nearest this PC, the last hop is the remote endpoint. Blend
// segment colors from cyan (local side) to amber (remote side) so the
// direction of the path reads at a glance.
const LOCAL_COLOR: [number, number, number] = [65, 199, 215];
const REMOTE_COLOR: [number, number, number] = [240, 180, 81];

function segmentColor(t: number) {
  const mix = LOCAL_COLOR.map((channel, i) => Math.round(channel + (REMOTE_COLOR[i] - channel) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function hopIcon(hop: number, t: number) {
  return L.divIcon({
    className: 'hop-badge-wrap',
    html: `<span class="hop-badge" style="border-color:${segmentColor(t)};color:${segmentColor(t)}">${hop}</span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

export function EndpointMap(props: {
  points: MapPoint[];
  routePoints: RoutePoint[];
  onSelect: (id: string) => void;
}) {
  const selected = props.points.find((point) => point.selected);
  const hops = props.routePoints;
  const maxIndex = Math.max(hops.length - 1, 1);

  return (
    <MapContainer
      center={[25, 10]}
      zoom={2}
      minZoom={2}
      maxZoom={19}
      worldCopyJump
      scrollWheelZoom
      style={{ width: '100%', height: '100%' }}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      />
      {hops.slice(1).map((hop, index) => {
        const previous = hops[index];
        const t = (index + 0.5) / maxIndex;
        return (
          <Polyline
            key={`segment-${index}`}
            positions={[
              [previous.latitude, previous.longitude],
              [hop.latitude, hop.longitude],
            ]}
            pathOptions={{
              color: segmentColor(t),
              weight: 2.5,
              dashArray: '6 10',
              opacity: 0.9,
              className: 'route-flow',
            }}
          />
        );
      })}
      {hops.map((hop, index) => (
        <Marker
          key={`hop-${hop.hop}`}
          position={[hop.latitude, hop.longitude]}
          icon={hopIcon(hop.hop, index / maxIndex)}
        >
          <Tooltip direction="top" offset={[0, -10]}>
            <div className="map-tooltip__title">Hop {hop.hop} · {hop.label}</div>
            {hop.sublabel && <div className="map-tooltip__sub">{hop.sublabel}</div>}
            {hop.latency && <div className="map-tooltip__sub">{hop.latency}</div>}
            <div className="map-tooltip__sub">
              {index === 0 ? 'Closest to this PC' : index === hops.length - 1 ? 'Remote endpoint' : `${hops.length - 1 - index} hop${hops.length - 1 - index === 1 ? '' : 's'} from the endpoint`}
            </div>
          </Tooltip>
        </Marker>
      ))}
      {props.points.map((point) => {
        const color = point.selected ? '#41c7d7' : '#f0b451';
        return (
          <CircleMarker
            key={point.id}
            center={[point.latitude, point.longitude]}
            radius={point.selected ? 9 : 6}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: point.selected ? 0.85 : 0.55,
              weight: point.selected ? 2 : 1.5,
            }}
            eventHandlers={{ click: () => props.onSelect(point.id) }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <div className="map-tooltip__title">{point.label}</div>
              {point.sublabel && <div className="map-tooltip__sub">{point.sublabel}</div>}
            </Tooltip>
          </CircleMarker>
        );
      })}
      <FitRoute points={hops} />
      <FlyToSelected point={selected} />
    </MapContainer>
  );
}

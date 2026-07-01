import { useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
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
  latitude: number;
  longitude: number;
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

export function EndpointMap(props: {
  points: MapPoint[];
  routePoints: RoutePoint[];
  onSelect: (id: string) => void;
}) {
  const selected = props.points.find((point) => point.selected);

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
      {props.routePoints.length > 1 && (
        <Polyline
          positions={props.routePoints.map((hop) => [hop.latitude, hop.longitude] as [number, number])}
          pathOptions={{ color: '#58d68d', weight: 2, dashArray: '5 10', opacity: 0.9 }}
        />
      )}
      {props.routePoints.map((hop, index) => (
        <CircleMarker
          key={`hop-${index}`}
          center={[hop.latitude, hop.longitude]}
          radius={4}
          pathOptions={{ color: '#58d68d', fillColor: '#58d68d', fillOpacity: 0.8, weight: 1 }}
        />
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
      <FlyToSelected point={selected} />
    </MapContainer>
  );
}

import { EndpointMap } from '../EndpointMap';
import type { Connection, Investigation, RouteTrace } from '../types';

export function WorldMap(props: {
  connections: Connection[];
  investigations: Record<string, Investigation>;
  selected: Connection | null;
  route?: RouteTrace;
  onSelect: (connection: Connection) => void;
}) {
  const plotted = props.connections
    .map((connection) => ({ connection, investigation: props.investigations[connection.remoteAddress] }))
    .filter((item) => typeof item.investigation?.geo?.latitude === 'number' && typeof item.investigation?.geo?.longitude === 'number');
  const routePoints = (props.route?.hops || [])
    .map((hop) => ({ hop, investigation: props.investigations[hop.address] }))
    .filter((item) => typeof item.investigation?.geo?.latitude === 'number' && typeof item.investigation?.geo?.longitude === 'number');

  return (
    <section className="panel map-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel__header">
        <div>
          <h2>Endpoint map</h2>
          <p>{plotted.length} located endpoints</p>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: '300px', margin: '0 10px', borderRadius: '8px', overflow: 'hidden', position: 'relative', zIndex: 0 }}>
        <EndpointMap
          points={plotted.map(({ connection, investigation }) => ({
            id: connection.id,
            latitude: investigation.geo.latitude!,
            longitude: investigation.geo.longitude!,
            label: connection.remoteAddress,
            sublabel: investigation.geo.city ? `${investigation.geo.city}, ${investigation.geo.country}` : investigation.geo.country,
            selected: props.selected?.id === connection.id,
          }))}
          routePoints={routePoints.map(({ hop, investigation }) => ({
            hop: hop.hop,
            latitude: investigation.geo.latitude!,
            longitude: investigation.geo.longitude!,
            label: hop.address,
            sublabel: investigation.geo.city
              ? `${investigation.geo.city}, ${investigation.geo.country}`
              : investigation.geo.country,
            latency: hop.latenciesMs.length
              ? `${Math.min(...hop.latenciesMs)}–${Math.max(...hop.latenciesMs)} ms`
              : undefined,
          }))}
          onSelect={(id) => {
            const item = plotted.find((entry) => entry.connection.id === id);
            if (item) props.onSelect(item.connection);
          }}
        />
      </div>
      <div className="map-caption" style={{ marginTop: '10px' }}>
        Select a connection and run Investigate to locate it. After Trace route, numbered hops show the path — cyan is your side, amber is the remote endpoint, and the dashes flow in the direction of incoming traffic.
      </div>
    </section>
  );
}

const fs = require('fs');
const svgPath = fs.readFileSync('D:\\projects\\netshield\\map-path.txt', 'utf8');

const tsx = `export function WorldMapSvg({ children }: { children?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 1000 500" role="img" aria-label="World endpoint map" className="world-map">
      <rect width="1000" height="500" rx="16" />
      <path d="${svgPath}" />
      {children}
    </svg>
  );
}
`;
fs.writeFileSync('D:\\projects\\netshield\\frontend\\src\\WorldMapSvg.tsx', tsx);
console.log('TSX created');

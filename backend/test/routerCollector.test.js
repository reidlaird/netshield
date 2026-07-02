import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClients, parseTopology, cleanHostname } from '../src/routerCollector.js';
import { isRandomizedMac, shortVendor } from '../src/deviceNames.js';

// Sample shapes taken from the Telus Wi-Fi Hub's cgi/cgi_clients.js.
const CLIENTS_JS = `
var dhcp_lease=[ 'TY_WR','192.168.1.71','68:57:2D:43:58:C2','12:12:26'
,'','192.168.1.76','3C:C5:DD:D7:CE:E1','12:39:15'
];
var dhcp_client=[ 'RALROG','192.168.1.75','d4:5d:64:c3:f7:dd','','LAN'
,'','192.168.1.66','5c:e7:53:0a:8c:58','','LAN'
,'Reid-s-S23-Ultra','192.168.1.74','ba:00:06:d4:7b:f1','','LAN'
];`;

const TOPO_JS = `
var toplogy_info={ "nodes": [ { "fw_ver": "v3.25.03", "sn": "ARCA1477F281", "device_ip": "192.168.1.254", "model_name": "TELUS Wi-Fi Hub", "product_id": "PRV65B444A-S-TS" } ], "cksum": "abc" };
var station_info={"stations":[{"station_mac":"BA:00:06:D4:7B:F1","station_name":"Reid-s-S23-Ultra","station_ip":"192.168.1.74","connect_type":"2.4G","link_rate":"1Mbps","signal_strength":"-67","online":"1"}]};`;

test('parses dhcp_client (groups of 5) with normalized MACs', () => {
  const devices = parseClients(CLIENTS_JS);
  assert.equal(devices.length, 3);
  assert.deepEqual(devices[0], { hostname: 'RALROG', ip: '192.168.1.75', mac: 'D4:5D:64:C3:F7:DD', iface: 'LAN' });
  // Blank hostname preserved (enrichment fills it in later).
  assert.equal(devices[1].hostname, '');
  assert.equal(devices[1].ip, '192.168.1.66');
});

test('falls back to dhcp_lease (groups of 4) when dhcp_client is absent', () => {
  const js = CLIENTS_JS.replace(/dhcp_client/g, 'other_name');
  const devices = parseClients(js);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].mac, '68:57:2D:43:58:C2');
  assert.equal(devices[0].hostname, 'TY_WR');
});

test('parses station_info and gateway node from topology', () => {
  const { stations, gateway } = parseTopology(TOPO_JS);
  const st = stations['BA:00:06:D4:7B:F1'];
  assert.equal(st.connectionType, '2.4G');
  assert.equal(st.signal, '-67');
  assert.equal(st.online, true);
  assert.equal(gateway.model, 'TELUS Wi-Fi Hub');
  assert.equal(gateway.firmware, 'v3.25.03');
  assert.equal(gateway.serial, 'ARCA1477F281');
});

test('returns empty list for input with no client arrays', () => {
  assert.deepEqual(parseClients('var something_else=1;'), []);
  assert.deepEqual(parseTopology('var x=1;'), { stations: {}, gateway: null });
});

test('treats router placeholder hostnames as empty', () => {
  for (const junk of ['(null)', 'NULL', 'null', 'unknown', '*', '--', '  ', '']) {
    assert.equal(cleanHostname(junk), '', `expected "${junk}" to clean to empty`);
  }
  assert.equal(cleanHostname('  steamdeck '), 'steamdeck');
  const js = `var dhcp_client=[ '(null)','192.168.1.66','5c:e7:53:0a:8c:58','','LAN' ];`;
  assert.equal(parseClients(js)[0].hostname, '');
});

test('detects locally administered (randomized) MACs', () => {
  assert.equal(isRandomizedMac('BA:00:06:D4:7B:F1'), true);
  assert.equal(isRandomizedMac('32:10:77:BD:35:9E'), true);
  assert.equal(isRandomizedMac('C4:DD:57:18:27:27'), false);
  assert.equal(isRandomizedMac('D4:5D:64:C3:F7:DD'), false);
});

test('shortens vendor names to their brand', () => {
  assert.equal(shortVendor('Samsung Electronics Co.,Ltd'), 'Samsung');
  assert.equal(shortVendor('Espressif Inc.'), 'Espressif');
  assert.equal(shortVendor('Microsoft Corporation'), 'Microsoft');
  assert.equal(shortVendor('Valve Corporation'), 'Valve');
  assert.equal(shortVendor('AzureWave Technology Inc.'), 'AzureWave');
  assert.equal(shortVendor('Intel Corporate'), 'Intel');
  assert.equal(shortVendor('Sonos'), 'Sonos');
});

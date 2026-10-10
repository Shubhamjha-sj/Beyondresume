// Central settings. Several can be overridden from the URL for testing,
// e.g. http://localhost:5173/?dpr=2&lod=1&noclip=1&debug=0
const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback);
const flag = (key, fallback) => (params.has(key) ? params.get(key) !== '0' : fallback);

// ?embed=1: running inside the IndustryProof call screen (an iframe). FabTwin then talks to the
// page around it through src/bridge.js, never speaks lines itself and shows no results page.
const embed = flag('embed', false);

export const CONFIG = {
  embed,
  // Assets (generated from the Marble export; see tools/build_navgrid.py)
  worldUrl: './assets/fab.spz',
  navGridUrl: './assets/navgrid.json',
  floorplanUrl: './assets/floorplan.json',
  layoutUrl: './assets/layout.json', // tool positions, rails
  scenarioUrl: `./scenarios/${params.get('scenario') || 'etch2-pressure-fault'}.json`,

  interactDistance: 3.2, // metres: how close you must be to use a tool with E

  // Player start: open floor near the generation viewpoint, looking down the aisle (-z).
  // x = -0.5 gives a clear walk past the operator workstation that sits just ahead.
  spawn: { x: -0.5, z: 2.0, yawDeg: 0 },
  eyeHeight: 1.6, // metres (the Marble world is roughly metric with the floor at y = 0)
  walkSpeed: 1.4, // m/s, normal walking pace
  fastSpeed: 2.6, // m/s while holding Shift

  // Rendering. Splats are fill-rate heavy, so we cap the pixel ratio on Retina screens.
  pixelRatio: num('dpr', Math.min(window.devicePixelRatio || 1, 1.25)),
  lod: flag('lod', false), // Spark level-of-detail; try ?lod=1 if the frame rate is low

  // Sound level for everything FabTwin plays. Embedded, the call's voice comes first; try ?vol=0.4
  volume: num('vol', embed ? 0.6 : 1),

  // Dev helpers (turn off for real candidates with ?dev=0&debug=0; always off when embedded)
  dev: !embed && flag('dev', true), // dev keys: N noclip, P copy position, J skip 15 s, ` read-out
  noclip: flag('noclip', false), // walk through everything
  debug: !embed && flag('debug', true), // position read-out top-left
};

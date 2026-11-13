// The agent's planned path, drawn as a hairline on the floor in the same
// style as the waypoint marker (fx/waypoint-marker.js). set(points) takes
// MJCF [x, y, ...] points (the nav stack's path) or null to hide.
import * as THREE from "three";

const COLOR = 0xff5710;
const FLOOR_Y = 0.012;

export function createPathLine() {
  const material = new THREE.LineBasicMaterial({
    color: COLOR, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(new THREE.BufferGeometry(), material);
  line.renderOrder = 5;
  line.visible = false;
  let shown = null;
  return {
    object: line,
    set(points) {
      if (points === shown) return;
      shown = points;
      line.visible = !!points?.length;
      if (!line.visible) return;
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p[0], FLOOR_Y, -p[1])));
    },
  };
}

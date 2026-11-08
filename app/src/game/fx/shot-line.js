// Shooting line: a dashed floor line from the ball to the aim point in the net,
// shown while the agent runs so viewers can see what it is lining up on.
// update(ballXY | null) each frame; null hides it. MJCF [x, y] in, three.js
// (x, floor, -y) out.
import * as THREE from "three";
import { GOAL_AIM } from "../goal.js";

const FLOOR_Y = 0.004; // just above the floor grid, below the ball

export function createShotLine() {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const material = new THREE.LineDashedMaterial({
    color: 0xff7a2f, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.85,
  });
  const line = new THREE.Line(geometry, material);
  line.visible = false;
  const pos = geometry.attributes.position;

  function update(ball) {
    line.visible = !!ball;
    if (!ball) return;
    pos.setXYZ(0, ball[0], FLOOR_Y, -ball[1]);
    pos.setXYZ(1, GOAL_AIM[0], FLOOR_Y, -GOAL_AIM[1]);
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
    line.computeLineDistances();
  }

  return { object: line, update };
}

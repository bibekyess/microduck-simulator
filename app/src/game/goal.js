// Soccer goal on the +x wall, straight ahead of the duck's spawn. One
// geometry definition feeds the physics colliders (MJCF), the render mesh
// (three.js) and the "is the ball in the net?" check, so all three agree.
//
// MJCF ground coords throughout (x forward, y left, z up); the mesh does
// the usual three.js mapping (x, z, -y) once.
import * as THREE from "three";
import { ARENA_HALF, BALL_RADIUS } from "./constants.js";

export const GOAL = {
  mouthX: ARENA_HALF - 0.3, // goal line (x of the opening)
  backX: ARENA_HALF - 0.02, // net back, just inside the arena wall
  halfWidth: 0.3, // opening spans y in [-halfWidth, halfWidth]
  height: 0.4, // crossbar height: above the duck (~0.3 m), so it can walk in
  post: 0.015, // post / bar half-thickness
};

// Centre of the goal mouth.
export const GOAL_CENTER = [GOAL.mouthX, 0];
// What the agent aims at: inside the net, past the mouth, so the ball ->
// aim direction stays sensible even when the ball sits near the line.
export const GOAL_AIM = [GOAL.mouthX + 0.15, 0];

// Static collision boxes: two posts, crossbar, back net and two side nets.
// The open front stays open so the ball can roll in.
export function goalColliders() {
  const { mouthX, backX, halfWidth: w, height: h, post: p } = GOAL;
  const midX = (mouthX + backX) / 2, halfDepth = (backX - mouthX) / 2;
  return [
    { name: "goal_post_l", pos: [mouthX, w + p, h / 2], size: [p, p, h / 2] },
    { name: "goal_post_r", pos: [mouthX, -w - p, h / 2], size: [p, p, h / 2] },
    { name: "goal_bar", pos: [mouthX, 0, h + p], size: [p, w + 2 * p, p] },
    { name: "goal_back", pos: [backX, 0, h / 2], size: [p, w + 2 * p, h / 2] },
    { name: "goal_side_l", pos: [midX, w + p, h / 2], size: [halfDepth, p, h / 2] },
    { name: "goal_side_r", pos: [midX, -w - p, h / 2], size: [halfDepth, p, h / 2] },
  ];
}

// Ball centre fully past the goal line and between the posts.
export function isBallInGoal(x, y) {
  return x > GOAL.mouthX + BALL_RADIUS && x < GOAL.backX && Math.abs(y) < GOAL.halfWidth;
}

// Render mesh: solid white frame (posts + bar) and translucent net panels,
// built from the same boxes as the colliders.
export function makeGoalMesh() {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const netMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, transparent: true, opacity: 0.25, wireframe: true,
  });
  for (const c of goalColliders()) {
    const isFrame = c.name === "goal_post_l" || c.name === "goal_post_r" || c.name === "goal_bar";
    // Net panels get a few segments so the wireframe reads as a mesh net.
    const seg = isFrame ? 1 : 8;
    const geo = new THREE.BoxGeometry(2 * c.size[0], 2 * c.size[2], 2 * c.size[1], seg, seg, seg);
    const mesh = new THREE.Mesh(geo, isFrame ? frameMat : netMat);
    mesh.position.set(c.pos[0], c.pos[2], -c.pos[1]);
    group.add(mesh);
  }
  return group;
}

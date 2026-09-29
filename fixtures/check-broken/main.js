// A game with problems only `gameshipper check` finds. tests/integration/check.int.test.ts checks that each is found.
import * as THREE from 'three';

// A leaderboard fetched from the internet while running. A fetch URL isn't an import, so building can't bundle it;
// only a run with the network blocked catches it.
fetch('https://example.com/scores.json').catch(() => {});

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(2, 2, 3);
camera.lookAt(0, 0, 0);
const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
scene.add(cube);

renderer.setAnimationLoop((t) => {
  cube.rotation.set(t / 1000, t / 1500, 0);
  renderer.render(scene, camera);
});

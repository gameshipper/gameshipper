import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(2, 2, 3);
new OrbitControls(camera, renderer.domElement);

const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
scene.add(cube);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((t) => {
  cube.rotation.set(t / 1000, t / 1500, 0);
  renderer.render(scene, camera);
});

// Lets the integration test confirm the game really renders: a WebGL context that failed would draw 0 frames.
setTimeout(() => console.log(`gameshipper-frames:${renderer.info.render.frame}`), 1500);

// Lets the integration test confirm the preload bridge and file saves work.
if (window.gameshipper) {
  await window.gameshipper.saves.save('smoke', { ok: true });
  console.log(`gameshipper-bridge:${JSON.stringify(await window.gameshipper.saves.load('smoke'))}`);
} else {
  console.log('gameshipper-bridge:absent');
}

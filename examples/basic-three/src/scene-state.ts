import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer
} from "three";

export {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer
};

export const scene = new Scene();

export const camera = new PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 0, -5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld()

export const cube = new Mesh(
  new BoxGeometry(1, 1, 1),
  new MeshBasicMaterial({ color: "red" })
);
cube.position.set(1.5, 0, 0);
scene.add(cube);

export function resizeCamera(width: number, height: number): void {
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

export function cubeCameraSpacePosition(): Vector3 {
  camera.updateMatrixWorld();
  cube.updateMatrixWorld();
  return cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
}


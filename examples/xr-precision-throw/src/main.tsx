import { Canvas, useFrame } from "@react-three/fiber";
import { Handle } from "@react-three/handle";
import {
  BallCollider,
  CuboidCollider,
  Physics,
  RigidBody,
  type RapierRigidBody,
  type Vector3Tuple,
  useRapier,
} from "@react-three/rapier";
import { PointerEvents, XR, createXRStore, noEvents, useXR } from "@react-three/xr";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { createRoot } from "react-dom/client";
import { Color, Group, Mesh, Object3D, Quaternion, Vector3 } from "three";
import type { HandleState } from "@react-three/handle";
import "./style.css";

const BALL_START: Vector3Tuple = [0, 1.25, -0.85];
const TARGET_POSITION: Vector3Tuple = [0, 1.55, -8.5];
const BALL_RADIUS = 0.12;

const xrStore = createXRStore({
  emulate: false,
  offerSession: false,
});

type GameStatus = "ready" | "holding" | "thrown" | "hit";

declare global {
  interface Window {
    xrPrecisionThrow?: {
      store: typeof xrStore;
      getStatus: () => GameStatus;
      getHitCount: () => number;
      getBallPosition: () => Vector3Tuple;
      reset: () => void;
    };
  }
}

function App(): ReactElement {
  return (
    <main className="app-shell">
      <div className="xr-actions" aria-label="XR session controls">
        <button type="button" onClick={() => void xrStore.enterVR()}>
          Enter VR
        </button>
      </div>
      <Canvas
        events={noEvents}
        camera={{ fov: 52, position: [0, 1.55, 2.2] }}
        gl={{ antialias: true }}
        shadows
      >
        <PointerEvents />
        <XR store={xrStore}>
          <color attach="background" args={["#10141a"]} />
          <fog attach="fog" args={["#10141a", 7, 15]} />
          <Scene />
        </XR>
      </Canvas>
    </main>
  );
}

function Scene(): ReactElement {
  const [status, setStatus] = useState<GameStatus>("ready");
  const [hitCount, setHitCount] = useState(0);
  const ballRef = useRef<RapierRigidBody>(null);
  const targetRef = useRef<Group>(null);
  const ballVisualRef = useRef<Mesh>(null);
  const releaseVelocity = useRef(new Vector3());
  const statusRef = useRef(status);
  const hitCountRef = useRef(hitCount);

  statusRef.current = status;
  hitCountRef.current = hitCount;

  const reset = useCallback(() => {
    const body = ballRef.current;
    if (!body) return;
    body.setBodyType(0, true);
    body.setTranslation(vectorFromTuple(BALL_START), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    releaseVelocity.current.set(0, 0, 0);
    targetRef.current?.position.set(...BALL_START);
    setStatus("ready");
  }, []);

  const getBallPosition = useCallback((): Vector3Tuple => {
    const bodyPosition = ballRef.current?.translation();
    if (bodyPosition) return [bodyPosition.x, bodyPosition.y, bodyPosition.z];

    const targetPosition = targetRef.current?.position;
    if (targetPosition) return [targetPosition.x, targetPosition.y, targetPosition.z];

    return BALL_START;
  }, []);

  useEffect(() => {
    window.xrPrecisionThrow = {
      store: xrStore,
      getStatus: () => statusRef.current,
      getHitCount: () => hitCountRef.current,
      getBallPosition,
      reset,
    };

    return () => {
      delete window.xrPrecisionThrow;
    };
  }, [getBallPosition, reset]);

  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight castShadow intensity={2.3} position={[3, 5, 2]} />
      <Physics gravity={[0, -9.81, 0]} timeStep="vary">
        <Pitch />
        <LaunchStand />
        <PrecisionTarget
          ballRef={ballRef}
          onHit={() => {
            setStatus("hit");
            setHitCount((value) => value + 1);
          }}
        />
        <ThrowableBall
          ballRef={ballRef}
          targetRef={targetRef}
          ballVisualRef={ballVisualRef}
          releaseVelocity={releaseVelocity}
          onGrab={() => setStatus("holding")}
          onThrow={() => setStatus("thrown")}
        />
        <ControllerThrow
          ballRef={ballRef}
          targetRef={targetRef}
          releaseVelocity={releaseVelocity}
          onGrab={() => setStatus("holding")}
          onThrow={() => setStatus("thrown")}
        />
      </Physics>
      <AimGuide status={status} />
    </>
  );
}

function ThrowableBall({
  ballRef,
  targetRef,
  ballVisualRef,
  releaseVelocity,
  onGrab,
  onThrow,
}: {
  ballRef: RefObject<RapierRigidBody | null>;
  targetRef: RefObject<Group | null>;
  ballVisualRef: RefObject<Mesh | null>;
  releaseVelocity: RefObject<Vector3>;
  onGrab: () => void;
  onThrow: () => void;
}): ReactElement {
  const { rapier } = useRapier();
  const handleTargetRef = targetRef as unknown as RefObject<Object3D | null>;

  useFrame(() => {
    const body = ballRef.current;
    const target = targetRef.current;
    if (!body || !target || body.bodyType() !== rapier.RigidBodyType.Dynamic) return;
    const position = body.translation();
    target.position.set(position.x, position.y, position.z);
  });

  return (
    <>
      <RigidBody
        ref={ballRef}
        colliders={false}
        ccd
        linearDamping={0.04}
        angularDamping={0.08}
        position={BALL_START}
        restitution={0.72}
      >
        <BallCollider args={[BALL_RADIUS]} />
      </RigidBody>
      <Handle
        translate
        rotate={false}
        scale={false}
        targetRef={handleTargetRef}
        apply={(state, target) => {
          applyBallHandle(state, target, ballRef.current, releaseVelocity.current, onGrab, onThrow, rapier);
          return undefined;
        }}
      >
        <group ref={targetRef} position={BALL_START}>
          <mesh ref={ballVisualRef} castShadow receiveShadow>
            <sphereGeometry args={[BALL_RADIUS, 32, 24]} />
            <meshStandardMaterial color="#f05d4f" roughness={0.46} metalness={0.08} />
          </mesh>
          <mesh scale={1.08}>
            <sphereGeometry args={[BALL_RADIUS, 16, 12]} />
            <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.22} />
          </mesh>
        </group>
      </Handle>
    </>
  );
}

function ControllerThrow({
  ballRef,
  targetRef,
  releaseVelocity,
  onGrab,
  onThrow,
}: {
  ballRef: RefObject<RapierRigidBody | null>;
  targetRef: RefObject<Group | null>;
  releaseVelocity: RefObject<Vector3>;
  onGrab: () => void;
  onThrow: () => void;
}): null {
  const { rapier } = useRapier();
  const controllers = useXR((state) => state.inputSourceStates.filter((input) => input.type === "controller"));
  const grabbed = useRef(false);
  const controllerHistory = useRef<Array<{ time: number; position: Vector3 }>>([]);
  const lastPosition = useRef(new Vector3());
  const followPosition = useRef(new Vector3());
  const controllerPosition = useRef(new Vector3());
  const controllerDirection = useRef(new Vector3());
  const controllerQuaternion = useRef(new Quaternion());

  useFrame((_, delta) => {
    const controller = controllers.find((input) => input.inputSource.handedness === "right") ?? controllers[0];
    const body = ballRef.current;
    const target = targetRef.current;

    if (!controller?.object || !body || !target) return;

    const trigger = controller.gamepad["xr-standard-trigger"]?.button ?? 0;
    const selecting = trigger > 0.5;

    controller.object.getWorldPosition(controllerPosition.current);
    controller.object.getWorldQuaternion(controllerQuaternion.current);
    controllerDirection.current.set(0, 0, -1).applyQuaternion(controllerQuaternion.current).normalize();
    followPosition.current.copy(controllerPosition.current).addScaledVector(controllerDirection.current, 0.18);

    if (!grabbed.current && selecting && controllerCanReachBall(controllerPosition.current, controllerDirection.current, target.position)) {
      grabbed.current = true;
      controllerHistory.current = [{ time: performance.now(), position: target.position.clone() }];
      lastPosition.current.copy(target.position);
      releaseVelocity.current.set(0, 0, 0);
      body.setBodyType(rapier.RigidBodyType.KinematicPositionBased, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      onGrab();
    }

    if (!grabbed.current) return;

    if (selecting) {
      target.position.copy(followPosition.current);
      body.setNextKinematicTranslation(followPosition.current);
      updateControllerThrowVelocity(controllerHistory.current, followPosition.current, releaseVelocity.current);
      lastPosition.current.copy(followPosition.current);
      return;
    }

    const velocity = releaseVelocity.current.clone();
    grabbed.current = false;
    body.setBodyType(rapier.RigidBodyType.Dynamic, true);
    body.setTranslation(target.position, true);
    body.setLinvel(velocity, true);
    body.setAngvel({ x: velocity.z * -5, y: 0, z: velocity.x * 5 }, true);
    onThrow();
  });

  return null;
}

function controllerCanReachBall(origin: Vector3, direction: Vector3, ballPosition: Vector3): boolean {
  const toBall = ballPosition.clone().sub(origin);
  const alongRay = toBall.dot(direction);
  const closest = origin.clone().addScaledVector(direction, Math.max(alongRay, 0));
  return origin.distanceTo(ballPosition) < 0.55 || (alongRay > 0 && alongRay < 1.8 && closest.distanceTo(ballPosition) < 0.26);
}

function updateControllerThrowVelocity(
  history: Array<{ time: number; position: Vector3 }>,
  position: Vector3,
  velocity: Vector3,
): void {
  const now = performance.now();
  history.push({ time: now, position: position.clone() });

  while (history.length > 2 && now - history[0].time > 180) {
    history.shift();
  }

  const first = history[0];
  const last = history[history.length - 1];
  const seconds = (last.time - first.time) / 1000;

  if (seconds > 0.025) {
    velocity.copy(last.position).sub(first.position).multiplyScalar(1 / seconds);
  }
}

function applyBallHandle(
  state: HandleState<unknown>,
  target: Object3D,
  body: RapierRigidBody | null,
  releaseVelocity: Vector3,
  onGrab: () => void,
  onThrow: () => void,
  rapier: ReturnType<typeof useRapier>["rapier"],
): void {
  const position = state.current.position;
  target.position.copy(position);

  if (!body) return;

  if (state.first) {
    body.setBodyType(rapier.RigidBodyType.KinematicPositionBased, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    onGrab();
  }

  body.setNextKinematicTranslation(position);

  if (state.delta && state.delta.time > 0) {
    releaseVelocity.copy(state.delta.position).multiplyScalar(1000 / state.delta.time);
  }

  if (state.last) {
    const velocity = releaseVelocity.clone().multiplyScalar(1.16);
    body.setBodyType(rapier.RigidBodyType.Dynamic, true);
    body.setTranslation(position, true);
    body.setLinvel(velocity, true);
    body.setAngvel({ x: velocity.z * -5, y: 0, z: velocity.x * 5 }, true);
    onThrow();
  }
}

function PrecisionTarget({
  ballRef,
  onHit,
}: {
  ballRef: RefObject<RapierRigidBody | null>;
  onHit: () => void;
}): ReactElement {
  const targetColor = useRef(new Color("#64d2ff"));

  return (
    <RigidBody
      type="fixed"
      colliders={false}
      position={TARGET_POSITION}
      onIntersectionEnter={(payload) => {
        if (payload.other.rigidBody?.handle === ballRef.current?.handle) onHit();
      }}
    >
      <CuboidCollider args={[0.19, 0.19, 0.025]} sensor />
      <mesh castShadow receiveShadow>
        <torusGeometry args={[0.28, 0.025, 12, 48]} />
        <meshStandardMaterial color={targetColor.current} emissive="#103448" emissiveIntensity={0.5} />
      </mesh>
      <mesh position={[0, 0, -0.015]}>
        <circleGeometry args={[0.18, 40]} />
        <meshStandardMaterial color="#eff8ff" roughness={0.55} />
      </mesh>
      <mesh position={[0, 0, -0.012]}>
        <circleGeometry args={[0.055, 32]} />
        <meshStandardMaterial color="#ffce5c" emissive="#553600" emissiveIntensity={0.3} />
      </mesh>
    </RigidBody>
  );
}

function Pitch(): ReactElement {
  return (
    <>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[2.2, 0.08, 5.4]} position={[0, -0.08, -4.1]} />
        <mesh receiveShadow position={[0, -0.09, -4.1]}>
          <boxGeometry args={[4.4, 0.08, 10.8]} />
          <meshStandardMaterial color="#25313d" roughness={0.9} />
        </mesh>
      </RigidBody>
      <mesh position={[0, 0.01, -4.3]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[1.2, 8.6, 1, 14]} />
        <meshBasicMaterial color="#3e515f" wireframe transparent opacity={0.42} />
      </mesh>
      <mesh position={[0, 1.55, -8.54]}>
        <boxGeometry args={[0.72, 0.72, 0.035]} />
        <meshStandardMaterial color="#1b2530" roughness={0.7} />
      </mesh>
    </>
  );
}

function LaunchStand(): ReactElement {
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[0.2, 0.025, 0.2]} position={[BALL_START[0], BALL_START[1] - BALL_RADIUS - 0.025, BALL_START[2]]} />
      <mesh castShadow receiveShadow position={[BALL_START[0], BALL_START[1] - BALL_RADIUS - 0.05, BALL_START[2]]}>
        <cylinderGeometry args={[0.18, 0.24, 0.1, 24]} />
        <meshStandardMaterial color="#425464" roughness={0.78} />
      </mesh>
      <mesh castShadow receiveShadow position={[BALL_START[0], BALL_START[1] - 0.42, BALL_START[2]]}>
        <cylinderGeometry args={[0.055, 0.075, 0.7, 18]} />
        <meshStandardMaterial color="#364653" roughness={0.82} />
      </mesh>
    </RigidBody>
  );
}

function AimGuide({ status }: { status: GameStatus }): ReactElement {
  const color = status === "hit" ? "#7cf29a" : status === "holding" ? "#ffce5c" : "#7aa7ff";

  return (
    <group position={[0, 1.18, -2.05]}>
      <mesh rotation-x={Math.PI / 2}>
        <ringGeometry args={[0.05, 0.052, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.72} />
      </mesh>
      <mesh position={[0, 0, -2.95]} rotation-x={Math.PI / 2}>
        <ringGeometry args={[0.085, 0.088, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.48} />
      </mesh>
    </group>
  );
}

function vectorFromTuple([x, y, z]: Vector3Tuple): Vector3 {
  return new Vector3(x, y, z);
}

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Missing #root element.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

export type InputMouseButton = "left" | "middle" | "right";

export type InputMouseClickCommand =
  | {
      type: "mouse.click";
      target: string;
      button?: InputMouseButton;
    }
  | {
      type: "mouse.click";
      x: number;
      y: number;
      button?: InputMouseButton;
    };

/**
 * Replaceable pointer movement for observation/input feedback loops.
 *
 * input() resolves after the first real pointer event. Movement then continues
 * independently. A later mouse.moveLatest replaces only unapplied movement;
 * mouse.stop ends it. A nonzero relative component smaller than one CSS pixel
 * becomes the smallest physical step in the same direction.
 */
export type InputMouseMoveLatestCommand =
  | {
      deltaX: number;
      deltaY: number;
      type: "mouse.moveLatest";
    }
  | {
      type: "mouse.moveLatest";
      x: number;
      y: number;
    };

export type InputMouseStopCommand = {
  type: "mouse.stop";
};

export type InputWaitCommand = {
  type: "wait";
  durationMs: number;
};

export type InputPhysicalCommand =
  | InputWaitCommand
  | {
      type: "keyboard.down";
      key: string;
      /** Optional bounded hold. Requests above the host maximum fail visibly. */
      releaseAfterMs?: number;
    }
  | {
      type: "keyboard.press";
      key: string;
      durationMs: number;
    }
  | {
      type: "keyboard.up";
      key: string;
    }
  | InputMouseClickCommand
  | {
      type: "mouse.down";
      button?: InputMouseButton;
      /** Optional bounded hold. Requests above the host maximum fail visibly. */
      releaseAfterMs?: number;
    }
  | {
      type: "mouse.press";
      button?: InputMouseButton;
      /** Awaiting input() waits for this complete press/release activation. */
      durationMs: number;
    }
  | {
      type: "mouse.up";
      button?: InputMouseButton;
    }
  | {
      type: "mouse.move";
      deltaX: number;
      deltaY: number;
      /** Settled movement. input() resolves only after the path settles. */
      durationMs: number;
    }
  | {
      type: "mouse.moveTo";
      x: number;
      y: number;
      /** Settled movement. input() resolves only after the path settles. */
      durationMs: number;
    }
  | InputMouseMoveLatestCommand
  | InputMouseStopCommand;

export type InputDownCommand = Extract<
  InputPhysicalCommand,
  { type: "keyboard.down" | "mouse.down" }
>;

export type InputMouseMoveLatestResult = {
  leaseMs: number;
  status: "latest.started";
};

export type InputCompleted = {
  status: "completed";
};

export type InputHeldResult = {
  edgeEmitted: boolean;
  expiresAt: number | null;
  releaseAfterMs: number | null;
  status: "held";
};

export type InputResult =
  | InputCompleted
  | InputHeldResult
  | InputMouseMoveLatestResult;

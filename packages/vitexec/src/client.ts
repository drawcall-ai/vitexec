export type WriteFileValue =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | string
  | unknown;

export type WriteFileResult = {
  path: string;
  bytes: number;
};

type WriteFileRequest = {
  path: string;
  encoding: "utf8" | "base64";
  data: string;
};

declare global {
  var __vitexecWriteFile: ((request: WriteFileRequest) => Promise<WriteFileResult>) | undefined;
}

function fileValueToBase64(value: ArrayBuffer | ArrayBufferView): string {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function normalizeFileValue(value: WriteFileValue): Promise<Omit<WriteFileRequest, "path">> {
  if (value instanceof Blob) {
    return {
      encoding: "base64",
      data: fileValueToBase64(await value.arrayBuffer())
    };
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return {
      encoding: "base64",
      data: fileValueToBase64(value)
    };
  }

  if (typeof value === "string") {
    return {
      encoding: "utf8",
      data: value
    };
  }

  return {
    encoding: "utf8",
    data: `${JSON.stringify(value, null, 2)}\n`
  };
}

export async function writeFile(
  path: string,
  value: WriteFileValue
): Promise<WriteFileResult> {
  if (typeof globalThis.__vitexecWriteFile !== "function") {
    throw new Error("vitexec writeFile is only available during a vitexec run.");
  }

  const normalized = await normalizeFileValue(value);
  return globalThis.__vitexecWriteFile({
    path,
    ...normalized
  });
}

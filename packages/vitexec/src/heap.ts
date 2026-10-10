import type { CDPSession } from "playwright";
import { writeJson } from "./files.js";

type DecodedHeapSnapshot = {
  schemaVersion: 1;
  nodes: DecodedHeapNode[];
  edges: DecodedHeapEdge[];
  summary: HeapSnapshotSummary;
};

type DecodedHeapNode = {
  index: number;
  ordinal: number;
  id?: number;
  type: string;
  name: string;
  selfSize: number;
  edgeCount: number;
  traceNodeId?: number;
};

type DecodedHeapEdge = {
  index: number;
  fromNodeIndex: number;
  fromNodeOrdinal: number;
  toNodeIndex: number;
  toNodeOrdinal: number;
  type: string;
  name: string;
};

type HeapSnapshotSummary = {
  topConstructorsByCount: HeapConstructorSummary[];
  topConstructorsBySelfSize: HeapConstructorSummary[];
  detachedDomNodeCount: number;
  largeStrings: HeapNodeSummary[];
  largeArrays: HeapNodeSummary[];
  largeArrayBuffers: HeapNodeSummary[];
};

type HeapConstructorSummary = {
  type: string;
  name: string;
  count: number;
  selfSize: number;
};

type HeapNodeSummary = {
  type: string;
  name: string;
  selfSize: number;
};

export async function saveHeapSnapshotSummary(cdp: CDPSession, path: string): Promise<void> {
  const chunks: string[] = [];
  const collectChunk = (event: unknown) => {
    if (isHeapSnapshotChunkEvent(event)) chunks.push(event.chunk);
  };

  cdp.on("HeapProfiler.addHeapSnapshotChunk", collectChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", collectChunk);
  }

  await writeJson(path, summarizeHeapSnapshot(JSON.parse(chunks.join(""))));
}

function isHeapSnapshotChunkEvent(value: unknown): value is { chunk: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "chunk" in value &&
    typeof value.chunk === "string"
  );
}

function summarizeHeapSnapshot(snapshot: unknown): DecodedHeapSnapshot {
  if (!isHeapSnapshot(snapshot)) {
    throw new Error("Chrome returned an unexpected heap snapshot shape.");
  }

  const meta = snapshot.snapshot.meta;
  const nodeFields = meta.node_fields;
  const nodeTypes = meta.node_types;
  const edgeFields = meta.edge_fields;
  const edgeTypes = meta.edge_types;
  const typeIndex = nodeFields.indexOf("type");
  const nameIndex = nodeFields.indexOf("name");
  const idIndex = nodeFields.indexOf("id");
  const selfSizeIndex = nodeFields.indexOf("self_size");
  const edgeCountIndex = nodeFields.indexOf("edge_count");
  const traceNodeIdIndex = nodeFields.indexOf("trace_node_id");
  const edgeTypeIndex = edgeFields.indexOf("type");
  const edgeNameOrIndexIndex = edgeFields.indexOf("name_or_index");
  const edgeToNodeIndex = edgeFields.indexOf("to_node");
  if (
    typeIndex === -1 ||
    nameIndex === -1 ||
    selfSizeIndex === -1 ||
    edgeCountIndex === -1 ||
    edgeTypeIndex === -1 ||
    edgeNameOrIndexIndex === -1 ||
    edgeToNodeIndex === -1
  ) {
    throw new Error("Chrome heap snapshot is missing expected node fields.");
  }

  const nodeFieldCount = nodeFields.length;
  const edgeFieldCount = edgeFields.length;
  const typeNames = nodeTypes[typeIndex];
  if (!Array.isArray(typeNames)) throw new Error("Missing heap node type names.");
  const edgeTypeNames = edgeTypes[edgeTypeIndex];
  if (!Array.isArray(edgeTypeNames)) throw new Error("Missing heap edge type names.");
  const constructors = new Map<string, HeapConstructorSummary>();
  const largeStrings: HeapNodeSummary[] = [];
  const largeArrays: HeapNodeSummary[] = [];
  const largeArrayBuffers: HeapNodeSummary[] = [];
  const nodeOrdinalByIndex = new Map<number, number>();
  const nodes: DecodedHeapNode[] = [];
  const edges: DecodedHeapEdge[] = [];
  let detachedDomNodeCount = 0;
  let ordinal = 0;

  for (let index = 0; index < snapshot.nodes.length; index += nodeFieldCount) {
    const type = typeNames[snapshot.nodes[index + typeIndex]] ?? "unknown";
    const name = snapshot.strings[snapshot.nodes[index + nameIndex]] ?? "";
    const selfSize = snapshot.nodes[index + selfSizeIndex] ?? 0;
    const edgeCount = snapshot.nodes[index + edgeCountIndex] ?? 0;

    const key = `${type}\0${name}`;
    const current = constructors.get(key) ?? { type, name, count: 0, selfSize: 0 };
    current.count += 1;
    current.selfSize += selfSize;
    constructors.set(key, current);

    if (name.includes("Detached")) detachedDomNodeCount += 1;
    const node = { type, name, selfSize };
    if (type === "string" && selfSize > 0) largeStrings.push(node);
    if (name === "Array" && selfSize > 0) largeArrays.push(node);
    if (name === "ArrayBuffer" && selfSize > 0) largeArrayBuffers.push(node);

    const decodedNode: DecodedHeapNode = {
      index,
      ordinal,
      type,
      name,
      selfSize,
      edgeCount
    };
    if (idIndex !== -1) decodedNode.id = snapshot.nodes[index + idIndex];
    if (traceNodeIdIndex !== -1) {
      decodedNode.traceNodeId = snapshot.nodes[index + traceNodeIdIndex];
    }
    nodeOrdinalByIndex.set(index, ordinal);
    nodes.push(decodedNode);
    ordinal += 1;
  }

  let edgeIndex = 0;
  let nodeIndex = 0;
  for (const node of nodes) {
    for (let edgeOffset = 0; edgeOffset < node.edgeCount; edgeOffset += 1) {
      const edgeType = edgeTypeNames[snapshot.edges[edgeIndex + edgeTypeIndex]] ?? "unknown";
      const nameOrIndex = snapshot.edges[edgeIndex + edgeNameOrIndexIndex] ?? 0;
      const toNodeIndex = snapshot.edges[edgeIndex + edgeToNodeIndex] ?? 0;
      edges.push({
        index: edgeIndex,
        fromNodeIndex: nodeIndex,
        fromNodeOrdinal: node.ordinal,
        toNodeIndex,
        toNodeOrdinal: nodeOrdinalByIndex.get(toNodeIndex) ?? -1,
        type: edgeType,
        name: formatHeapEdgeName(edgeType, nameOrIndex, snapshot.strings)
      });
      edgeIndex += edgeFieldCount;
    }
    nodeIndex += nodeFieldCount;
  }

  return {
    schemaVersion: 1,
    nodes,
    edges,
    summary: {
      topConstructorsByCount: sortByCount(constructors.values()).slice(0, 50),
      topConstructorsBySelfSize: sortBySelfSize(constructors.values()).slice(0, 50),
      detachedDomNodeCount,
      largeStrings: sortNodesBySelfSize(largeStrings).slice(0, 50),
      largeArrays: sortNodesBySelfSize(largeArrays).slice(0, 50),
      largeArrayBuffers: sortNodesBySelfSize(largeArrayBuffers).slice(0, 50)
    }
  };
}

type HeapSnapshot = {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string | string[])[];
      edge_fields: string[];
      edge_types: (string | string[])[];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === "number");
}

function isStringArrays(value: unknown): value is (string | string[])[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" || isStrings(item));
}

function isHeapSnapshot(value: unknown): value is HeapSnapshot {
  if (typeof value !== "object" || value === null || !("snapshot" in value)) return false;
  const snapshot = value.snapshot;
  if (typeof snapshot !== "object" || snapshot === null || !("meta" in snapshot)) return false;
  const meta = snapshot.meta;
  return typeof meta === "object" && meta !== null &&
    "node_fields" in meta && isStrings(meta.node_fields) &&
    "node_types" in meta && isStringArrays(meta.node_types) &&
    "edge_fields" in meta && isStrings(meta.edge_fields) &&
    "edge_types" in meta && isStringArrays(meta.edge_types) &&
    "nodes" in value && isNumbers(value.nodes) &&
    "edges" in value && isNumbers(value.edges) &&
    "strings" in value && isStrings(value.strings);
}

function formatHeapEdgeName(type: string, nameOrIndex: number, strings: string[]): string {
  if (type === "element" || type === "hidden") return String(nameOrIndex);
  return strings[nameOrIndex] ?? String(nameOrIndex);
}

function sortByCount(values: Iterable<HeapConstructorSummary>): HeapConstructorSummary[] {
  return [...values].sort((a, b) => b.count - a.count || b.selfSize - a.selfSize);
}

function sortBySelfSize(values: Iterable<HeapConstructorSummary>): HeapConstructorSummary[] {
  return [...values].sort((a, b) => b.selfSize - a.selfSize || b.count - a.count);
}

function sortNodesBySelfSize(values: HeapNodeSummary[]): HeapNodeSummary[] {
  return values.sort((a, b) => b.selfSize - a.selfSize);
}

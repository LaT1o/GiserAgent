/** 前端地图工作区与 Agent/服务端交互的稳定契约。 */
export type MapArtifactFormat = "geojson" | "raster" | "table";

export interface MapArtifactRef {
  id: string;
  projectId?: string;
  format: MapArtifactFormat;
  dataCrs?: string;
  relativePath?: string;
  bounds?: [number, number, number, number];
  featureCount?: number;
  fields?: Array<{ name: string; dtype: string }>;
  source?: { tool: string; sessionId: string; runId?: string };
  status?: "ready" | "detached" | "failed";
}

export type MapCommandName =
  | "listLayers"
  | "getCurrentLayer"
  | "addLayer"
  | "removeLayer"
  | "setVisibility"
  | "reorder"
  | "zoomToLayer"
  | "zoomToFeature"
  | "queryFeatures"
  | "exportLayer"
  | "getViewport"
  | "selectFeature";

export interface MapCommand<TInput = unknown> {
  name: MapCommandName;
  input?: TInput;
}

export interface MapInteractionState {
  projectId?: string;
  layerId?: string;
  featureId?: string;
  selectedProperties?: Record<string, unknown>;
  view?: { center: [number, number]; zoom: number; crs: string };
}

/** UI 与后续 Agent 工具共用的最小命令总线接口；实现只接受受控 artifact id。 */
export interface MapCommandBus {
  execute<TOutput = unknown>(command: MapCommand): Promise<TOutput>;
  getInteractionState(): MapInteractionState;
}

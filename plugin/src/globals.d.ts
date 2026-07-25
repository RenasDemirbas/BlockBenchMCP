// Blockbench 5.x runtime globals used by the MCP bridge plugin.
// Typed as `any` — the authoritative API is the running app itself.
export {};

declare global {
  // Browser globals (DOM lib is disabled to avoid type clashes with
  // Blockbench's Animation/Plugin globals)
  const document: any;
  const window: any;
  type WebSocket = any;
  const WebSocket: any;
  type HTMLCanvasElement = any;
  type CanvasRenderingContext2D = any;
  type CanvasGradient = any;
  type MessageEvent = any;

  const Blockbench: any;
  const Plugin: any;
  const Plugins: any;
  const isApp: boolean;

  const Project: any;
  const ModelProject: any;
  const Format: any;
  const Formats: any;
  const ModelFormat: any;
  const Codec: any;
  const Codecs: any;
  const AnimationCodec: any;
  function newProject(format: any): boolean;
  function setupProject(format: any, uuid?: string): boolean;
  function loadModelFile(file: any, args?: any): void;

  const Outliner: any;
  const OutlinerNode: any;
  const OutlinerElement: any;
  const Group: any;
  const Cube: any;
  const CubeFace: any;
  const Mesh: any;
  const MeshFace: any;
  const Locator: any;
  const NullObject: any;
  const TextureMesh: any;
  const Billboard: any;
  const Armature: any;
  const ArmatureBone: any;
  const Collection: any;
  function getCurrentGroup(): any;
  function getAllGroups(): any[];
  function unselectAllElements(exceptions?: any[]): void;
  function updateSelection(): void;

  const Canvas: any;
  const Undo: any;
  const Screencam: any;
  const Preview: any;
  const MediaPreview: any;
  const DefaultCameraPresets: any[];
  const Modes: any;
  const Mode: any;

  const Texture: any;
  const TextureLayer: any;
  const TextureGroup: any;
  const TextureGenerator: any;
  const Painter: any;
  const ColorPanel: any;
  const UVEditor: any;
  const UVSizeUtil: any;

  const Animator: any;
  const Timeline: any;
  const Animation: any;
  const AnimationItem: any;
  const AnimationController: any;
  const AnimationControllerState: any;
  const Keyframe: any;
  const KeyframeDataPoint: any;
  const GeneralAnimator: any;
  const BoneAnimator: any;
  const EffectAnimator: any;

  const DisplayMode: any;
  class DisplaySlot {
    constructor(id?: string);
    extend(data: any): any;
  }

  const BarItems: any;
  const MenuBar: any;
  const Action: any;
  const Setting: any;
  const Settings: any;
  const Dialog: any;
  const settings: any;

  const THREE: any;
  function guid(): string;
  function tl(key: string, args?: any, fallback?: string): string;
  const PathModule: any;
  /** js/native_apis.ts — home/desktop/temp/appdata paths without require('os'). */
  const SystemInfo: any;
  /** StateMemory.dialog_paths: last folder the user picked, per file type. */
  const StateMemory: any;
  const recent_projects: any[];

  interface Array<T> {
    safePush(...items: T[]): boolean;
    remove(...items: T[]): void;
    empty(): T[];
    replace(items: T[]): void;
    last(): T;
  }
}

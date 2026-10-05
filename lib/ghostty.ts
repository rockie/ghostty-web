/**
 * TypeScript wrapper for the libghostty-vt WASM API
 *
 * Binds the upstream libghostty-vt C API (terminal, render state, grid refs,
 * key encoder) and adapts it to the cell-array model the renderer, buffer and
 * selection code use. Struct layouts and enum values are resolved at load time
 * from the library's own type description (see ./wasm-abi.ts).
 */

import {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  Key,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
  type TerminalHandle,
} from './types';
import { CallbackTable, WasmAbi } from './wasm-abi';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

/** Default scrollback when no config is given (lines, xterm.js semantics). */
const DEFAULT_SCROLLBACK_LINES = 10000;

/** DEC private mode 2027: grapheme clustering. */
const MODE_GRAPHEME_CLUSTER = 2027;
/** ANSI mode 20: linefeed / new line mode. */
const MODE_LINEFEED = 20;

/**
 * Everything a terminal or key encoder needs from the loaded module:
 * exports, resolved ABI constants and shared callback slots.
 */
class Runtime {
  readonly exports: GhosttyWasmExports;
  readonly abi: WasmAbi;
  readonly k: ReturnType<typeof resolveConstants>;
  readonly terminals = new Map<TerminalHandle, GhosttyTerminal>();
  readonly writePtyCallback: number;
  readonly deviceAttributesCallback: number;
  /** Maps ghostty-web's Key enum values to the library's GhosttyKey values. */
  readonly keyMap: Int32Array;

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports;
    this.abi = new WasmAbi(exports);
    this.k = resolveConstants(this.abi);
    this.keyMap = buildKeyMap(this.abi);

    const callbacks = new CallbackTable(exports);
    this.writePtyCallback = callbacks.add(
      (terminal, _userdata, ptr, len) => {
        const bytes = this.u8().slice(ptr, ptr + len);
        this.terminals.get(terminal)?.queueResponse(new TextDecoder().decode(bytes));
      },
      4,
      false
    );
    this.deviceAttributesCallback = callbacks.add(
      (_terminal, _userdata, out) => this.fillDeviceAttributes(out),
      3,
      true
    );
  }

  u8(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.exports.memory.buffer);
  }

  alloc(len: number): number {
    const ptr = this.exports.ghostty_wasm_alloc(len);
    if (ptr === 0) throw new Error('libghostty-vt: out of memory');
    this.u8().fill(0, ptr, ptr + len);
    return ptr;
  }

  free(ptr: number, len: number): void {
    this.exports.ghostty_wasm_free(ptr, len);
  }

  check(result: number, what: string): void {
    if (result !== this.k.SUCCESS) throw new Error(`libghostty-vt: ${what} failed (${result})`);
  }

  /** Runs a `new(allocator, *out)` style constructor and returns the handle. */
  createOpaque(ctor: (slot: number) => number, what: string): number {
    const slot = this.exports.ghostty_wasm_alloc_opaque();
    if (slot === 0) throw new Error('libghostty-vt: out of memory');
    try {
      this.check(ctor(slot), what);
      return this.exports.ghostty_wasm_take_opaque(slot);
    } finally {
      this.exports.ghostty_wasm_free_opaque(slot);
    }
  }

  /**
   * DA1/DA2/DA3 replies. Matches what earlier ghostty-web builds reported:
   * VT220 with color (CSI ? 62 ; 22 c) and firmware 1.10.0 (CSI > 1 ; 10 ; 0 c).
   */
  private fillDeviceAttributes(out: number): number {
    const { abi } = this;
    this.u8().fill(0, out, out + abi.size('GhosttyDeviceAttributes'));
    const view = this.view();
    const primary = out + abi.offset('GhosttyDeviceAttributes', 'primary');
    view.setUint16(
      primary + abi.offset('GhosttyDeviceAttributesPrimary', 'conformance_level'),
      62,
      true
    );
    view.setUint16(primary + abi.offset('GhosttyDeviceAttributesPrimary', 'features'), 22, true);
    view.setUint32(primary + abi.offset('GhosttyDeviceAttributesPrimary', 'num_features'), 1, true);
    const secondary = out + abi.offset('GhosttyDeviceAttributes', 'secondary');
    view.setUint16(
      secondary + abi.offset('GhosttyDeviceAttributesSecondary', 'device_type'),
      1,
      true
    );
    view.setUint16(
      secondary + abi.offset('GhosttyDeviceAttributesSecondary', 'firmware_version'),
      10,
      true
    );
    return 1;
  }
}

function resolveConstants(abi: WasmAbi) {
  const e = (type: string) => abi.enumValues(type);
  const result = e('GhosttyResult');
  const terminalOption = e('GhosttyTerminalOption');
  const terminalData = e('GhosttyTerminalData');
  const renderData = e('GhosttyRenderStateData');
  const rowData = e('GhosttyRenderStateRowData');
  const cellsData = e('GhosttyRenderStateRowCellsData');
  const cellData = e('GhosttyCellData');
  const need = (values: Record<string, number>, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`libghostty-vt ABI is missing ${name}`);
    return value;
  };
  return {
    SUCCESS: need(result, 'SUCCESS'),
    OUT_OF_SPACE: need(result, 'OUT_OF_SPACE'),
    OPT_WRITE_PTY: need(terminalOption, 'WRITE_PTY'),
    OPT_DEVICE_ATTRIBUTES: need(terminalOption, 'DEVICE_ATTRIBUTES'),
    OPT_COLOR_FOREGROUND: need(terminalOption, 'COLOR_FOREGROUND'),
    OPT_COLOR_BACKGROUND: need(terminalOption, 'COLOR_BACKGROUND'),
    OPT_COLOR_CURSOR: need(terminalOption, 'COLOR_CURSOR'),
    OPT_COLOR_PALETTE: need(terminalOption, 'COLOR_PALETTE'),
    OPT_SCROLLBACK_MAX_LINES: need(terminalOption, 'SCROLLBACK_MAX_LINES'),
    OPT_SCROLLBACK_MAX_BYTES: need(terminalOption, 'SCROLLBACK_MAX_BYTES'),
    OPT_MODE: need(terminalOption, 'MODE'),
    DATA_ACTIVE_SCREEN: need(terminalData, 'ACTIVE_SCREEN'),
    DATA_SCROLLBACK_ROWS: need(terminalData, 'SCROLLBACK_ROWS'),
    DATA_CURSOR_X: need(terminalData, 'CURSOR_X'),
    DATA_CURSOR_Y: need(terminalData, 'CURSOR_Y'),
    DATA_MODE: need(terminalData, 'MODE'),
    SCREEN_ALTERNATE: abi.enumValue('GhosttyTerminalScreen', 'ALTERNATE'),
    RS_DIRTY: need(renderData, 'DIRTY'),
    RS_ROW_ITERATOR: need(renderData, 'ROW_ITERATOR'),
    RS_COLORS: need(renderData, 'COLORS'),
    RS_CURSOR_VISIBLE: need(renderData, 'CURSOR_VISIBLE'),
    RS_CURSOR_VIEWPORT_HAS_VALUE: need(renderData, 'CURSOR_VIEWPORT_HAS_VALUE'),
    RS_CURSOR_VIEWPORT_X: need(renderData, 'CURSOR_VIEWPORT_X'),
    RS_CURSOR_VIEWPORT_Y: need(renderData, 'CURSOR_VIEWPORT_Y'),
    DIRTY_FALSE: abi.enumValue('GhosttyRenderStateDirty', 'FALSE'),
    DIRTY_FULL: abi.enumValue('GhosttyRenderStateDirty', 'FULL'),
    ROW_CELLS: need(rowData, 'CELLS'),
    CELLS_RAW: need(cellsData, 'RAW'),
    CELLS_STYLE: need(cellsData, 'STYLE'),
    CELLS_GRAPHEMES_LEN: need(cellsData, 'GRAPHEMES_LEN'),
    CELLS_GRAPHEMES_BUF: need(cellsData, 'GRAPHEMES_BUF'),
    CELLS_BG_COLOR: need(cellsData, 'BG_COLOR'),
    CELLS_FG_COLOR: need(cellsData, 'FG_COLOR'),
    CELLS_HAS_STYLING: need(cellsData, 'HAS_STYLING'),
    CELL_CODEPOINT: need(cellData, 'CODEPOINT'),
    CELL_CONTENT_TAG: need(cellData, 'CONTENT_TAG'),
    CELL_WIDE: need(cellData, 'WIDE'),
    CELL_HAS_STYLING: need(cellData, 'HAS_STYLING'),
    CELL_HAS_HYPERLINK: need(cellData, 'HAS_HYPERLINK'),
    CELL_COLOR_PALETTE: need(cellData, 'COLOR_PALETTE'),
    CELL_COLOR_RGB: need(cellData, 'COLOR_RGB'),
    ROW_WRAP_CONTINUATION: abi.enumValue('GhosttyRowData', 'WRAP_CONTINUATION'),
    WIDE_WIDE: abi.enumValue('GhosttyCellWide', 'WIDE'),
    WIDE_SPACER_TAIL: abi.enumValue('GhosttyCellWide', 'SPACER_TAIL'),
    WIDE_SPACER_HEAD: abi.enumValue('GhosttyCellWide', 'SPACER_HEAD'),
    CONTENT_CODEPOINT_GRAPHEME: abi.enumValue('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
    CONTENT_BG_PALETTE: abi.enumValue('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
    CONTENT_BG_RGB: abi.enumValue('GhosttyCellContentTag', 'BG_COLOR_RGB'),
    COLOR_TAG_PALETTE: abi.enumValue('GhosttyStyleColorTag', 'PALETTE'),
    COLOR_TAG_RGB: abi.enumValue('GhosttyStyleColorTag', 'RGB'),
    POINT_ACTIVE: abi.enumValue('GhosttyPointTag', 'ACTIVE'),
    POINT_HISTORY: abi.enumValue('GhosttyPointTag', 'HISTORY'),
    STYLE_SIZE: abi.size('GhosttyStyle'),
    STYLE_FG: abi.offset('GhosttyStyle', 'fg_color'),
    STYLE_BG: abi.offset('GhosttyStyle', 'bg_color'),
    COLOR_TAG: abi.offset('GhosttyStyleColor', 'tag'),
    COLOR_PALETTE_INDEX: abi.offset('GhosttyStyleColor', 'value.palette'),
    COLOR_RGB: abi.offset('GhosttyStyleColor', 'value.rgb'),
    STYLE_FLAGS: [
      [abi.offset('GhosttyStyle', 'bold'), CellFlags.BOLD],
      [abi.offset('GhosttyStyle', 'italic'), CellFlags.ITALIC],
      [abi.offset('GhosttyStyle', 'strikethrough'), CellFlags.STRIKETHROUGH],
      [abi.offset('GhosttyStyle', 'inverse'), CellFlags.INVERSE],
      [abi.offset('GhosttyStyle', 'invisible'), CellFlags.INVISIBLE],
      [abi.offset('GhosttyStyle', 'blink'), CellFlags.BLINK],
      [abi.offset('GhosttyStyle', 'faint'), CellFlags.FAINT],
    ] as const,
    STYLE_UNDERLINE: abi.offset('GhosttyStyle', 'underline'),
    COLORS_SIZE: abi.size('GhosttyRenderStateColors'),
    COLORS_BACKGROUND: abi.offset('GhosttyRenderStateColors', 'background'),
    COLORS_FOREGROUND: abi.offset('GhosttyRenderStateColors', 'foreground'),
    COLORS_PALETTE: abi.offset('GhosttyRenderStateColors', 'palette'),
    POINT_SIZE: abi.size('GhosttyPoint'),
    POINT_TAG: abi.offset('GhosttyPoint', 'tag'),
    POINT_X: abi.offset('GhosttyPoint', 'value.coordinate.x'),
    POINT_Y: abi.offset('GhosttyPoint', 'value.coordinate.y'),
    GRID_REF_SIZE: abi.size('GhosttyGridRef'),
    GRID_REF_X: abi.offset('GhosttyGridRef', 'x'),
    MODE_CONFIG_SIZE: abi.size('GhosttyTerminalModeConfig'),
    MODE_CONFIG_MODE: abi.offset('GhosttyTerminalModeConfig', 'mode'),
    MODE_CONFIG_VALUE: abi.offset('GhosttyTerminalModeConfig', 'value'),
  };
}

/**
 * ghostty-web's public Key enum predates the libghostty-vt C API, which
 * renamed a few groups of keys (digits, arrows, numpad). Map by name.
 */
function buildKeyMap(abi: WasmAbi): Int32Array {
  const upstream = abi.enumValues('GhosttyKey');
  const unidentified = upstream.UNIDENTIFIED ?? 0;
  const digits = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
  const numpad: Record<string, string> = {
    KP_PLUS: 'NUMPAD_ADD',
    KP_MINUS: 'NUMPAD_SUBTRACT',
    KP_PERIOD: 'NUMPAD_DECIMAL',
  };
  const rename = (name: string): string => {
    if (name === 'GRAVE') return 'BACKQUOTE';
    if (digits.includes(name)) return `DIGIT_${digits.indexOf(name)}`;
    if (name === 'UP' || name === 'DOWN' || name === 'LEFT' || name === 'RIGHT')
      return `ARROW_${name}`;
    if (name.startsWith('KP_')) return numpad[name] ?? `NUMPAD_${name.slice(3)}`;
    return name;
  };
  const entries = Object.entries(Key).filter(([, value]) => typeof value === 'number') as [
    string,
    number,
  ][];
  const map = new Int32Array(Math.max(...entries.map(([, value]) => value)) + 1).fill(unidentified);
  for (const [name, value] of entries) {
    map[value] = upstream[rename(name)] ?? unidentified;
  }
  return map;
}

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  private runtime: Runtime;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.runtime = new Runtime(wasmInstance.exports as GhosttyWasmExports);
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.runtime);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new GhosttyTerminal(this.runtime, cols, rows, config);
  }

  static async load(wasmPath?: string): Promise<Ghostty> {
    // If explicit path provided, use it
    if (wasmPath) {
      return Ghostty.loadFromPath(wasmPath);
    }

    // Resolve path relative to this module
    const moduleUrl = new URL('../ghostty-vt.wasm', import.meta.url);

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first (strip file:// protocol)
    if (moduleUrl.protocol === 'file:') {
      let filePath = moduleUrl.pathname;
      // Remove leading slash on Windows paths (e.g., /C:/ -> C:/)
      if (filePath.match(/^\/[A-Za-z]:\//)) {
        filePath = filePath.slice(1);
      }
      defaultPaths.push(filePath);
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work
    if (!wasmBytes) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    // libghostty-vt has no imports; the module is self-contained.
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    return new Ghostty(wasmInstance);
  }
}

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private runtime: Runtime;
  private encoder: number = 0;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.encoder = runtime.createOpaque(
      (slot) => runtime.exports.ghostty_key_encoder_new(0, slot),
      'key encoder creation'
    );
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const { runtime } = this;
    const valuePtr = runtime.alloc(1);
    runtime.view().setUint8(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value);
    runtime.exports.ghostty_key_encoder_setopt(this.encoder, option, valuePtr);
    runtime.free(valuePtr, 1);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const { runtime } = this;
    const { exports } = runtime;
    const eventPtr = runtime.createOpaque(
      (slot) => exports.ghostty_key_event_new(0, slot),
      'key event creation'
    );

    let utf8Ptr = 0;
    let utf8Len = 0;
    const bufferSize = 128;
    const bufPtr = runtime.alloc(bufferSize);
    const writtenPtr = runtime.alloc(4);
    try {
      exports.ghostty_key_event_set_action(eventPtr, event.action);
      exports.ghostty_key_event_set_key(eventPtr, runtime.keyMap[event.key] ?? 0);
      exports.ghostty_key_event_set_mods(eventPtr, event.mods);
      if (event.consumedMods !== undefined) {
        exports.ghostty_key_event_set_consumed_mods(eventPtr, event.consumedMods);
      }
      if (event.composing !== undefined) {
        exports.ghostty_key_event_set_composing(eventPtr, event.composing);
      }
      if (event.unshiftedCodepoint !== undefined) {
        exports.ghostty_key_event_set_unshifted_codepoint(eventPtr, event.unshiftedCodepoint);
      }
      if (event.utf8) {
        const utf8Bytes = new TextEncoder().encode(event.utf8);
        utf8Len = utf8Bytes.length;
        utf8Ptr = runtime.alloc(utf8Len);
        runtime.u8().set(utf8Bytes, utf8Ptr);
        exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8Len);
      }

      const result = exports.ghostty_key_encoder_encode(
        this.encoder,
        eventPtr,
        bufPtr,
        bufferSize,
        writtenPtr
      );
      if (result !== runtime.k.SUCCESS) throw new Error(`Failed to encode key: ${result}`);

      const bytesWritten = runtime.view().getUint32(writtenPtr, true);
      return runtime.u8().slice(bufPtr, bufPtr + bytesWritten);
    } finally {
      if (utf8Ptr) runtime.free(utf8Ptr, utf8Len);
      runtime.free(bufPtr, bufferSize);
      runtime.free(writtenPtr, 4);
      exports.ghostty_key_event_free(eventPtr);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.runtime.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

/** Scratch memory layout shared by all queries of one terminal. */
interface Scratch {
  base: number;
  size: number;
  /** Handle slots the render state populates (pre-allocated objects). */
  rowIteratorSlot: number;
  rowCellsSlot: number;
  /** Small outputs: u16/u32/bool/u64/rgb values, one per slot. */
  out: number;
  outY: number;
  keys: number;
  values: number;
  multi: number;
  style: number;
  colors: number;
  point: number;
  gridRef: number;
  modeConfig: number;
}

function layoutScratch(runtime: Runtime): Scratch {
  const { k } = runtime;
  let size = 0;
  const take = (bytes: number) => {
    const at = size;
    size += Math.ceil(bytes / 16) * 16;
    return at;
  };
  const offsets = {
    rowIteratorSlot: take(4),
    rowCellsSlot: take(4),
    out: take(16),
    outY: take(4),
    keys: take(4 * 8),
    values: take(4 * 8),
    multi: take(8 * 8),
    style: take(k.STYLE_SIZE),
    colors: take(k.COLORS_SIZE),
    point: take(k.POINT_SIZE),
    gridRef: take(k.GRID_REF_SIZE),
    modeConfig: take(k.MODE_CONFIG_SIZE),
  };
  const base = runtime.alloc(size);
  const scratch = { base, size } as Scratch;
  for (const [name, offset] of Object.entries(offsets)) {
    (scratch as any)[name] = base + offset;
  }
  return scratch;
}

/**
 * GhosttyTerminal - terminal emulator backed by libghostty-vt
 *
 * The render state is synced lazily: writes only mark it stale, and the next
 * query updates it once and re-reads just the rows libghostty-vt reports as
 * dirty into a per-row cell cache. Dirty state accumulates until markClean(),
 * so update() can be called any number of times per frame.
 */
export class GhosttyTerminal {
  private runtime: Runtime;
  private handle: TerminalHandle;
  private renderState: number;
  private rowIterator: number;
  private rowCells: number;
  private scratch: Scratch;
  private _cols: number;
  private _rows: number;

  /** Cached viewport cells, one array per row (reused objects). */
  private rowCache: GhosttyCell[][] = [];
  /** Full grapheme strings for multi-codepoint cells, keyed by row * cols + col. */
  private graphemes = new Map<number, number[]>();
  private rowDirty: Uint8Array = new Uint8Array(0);
  private dirty: DirtyState = DirtyState.FULL;
  private stale = true;
  private needsFullRead = true;
  private lastScreen = -1;

  /** Default colors and palette from the last render state update. */
  private defaultFg: RGB = { r: 204, g: 204, b: 204 };
  private defaultBg: RGB = { r: 0, g: 0, b: 0 };
  private palette = new Uint8Array(256 * 3);

  private graphemeBufferPtr = 0;
  private graphemeBufferLen = 0;

  /** Replies the terminal produced for the PTY (DSR, DA, DECRQM, ...). */
  private responses: string[] = [];

  /** Flat viewport array returned by getViewport(). */
  private cellPool: GhosttyCell[] = [];

  constructor(
    runtime: Runtime,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.runtime = runtime;
    this._cols = cols;
    this._rows = rows;
    const { exports, k } = runtime;

    this.handle = runtime.createOpaque(
      (slot) => exports.ghostty_terminal_new(0, slot, cols, rows),
      'terminal creation'
    );
    this.renderState = runtime.createOpaque(
      (slot) => exports.ghostty_render_state_new(0, slot),
      'render state creation'
    );
    this.rowIterator = runtime.createOpaque(
      (slot) => exports.ghostty_render_state_row_iterator_new(0, slot),
      'row iterator creation'
    );
    this.rowCells = runtime.createOpaque(
      (slot) => exports.ghostty_render_state_row_cells_new(0, slot),
      'row cells creation'
    );
    this.scratch = layoutScratch(runtime);
    runtime.terminals.set(this.handle, this);

    this.setOption(k.OPT_WRITE_PTY, runtime.writePtyCallback);
    this.setOption(k.OPT_DEVICE_ATTRIBUTES, runtime.deviceAttributesCallback);
    this.applyConfig(config);
    // Match native terminal behavior: LF must not imply CR (breaks nvim).
    this.setMode(MODE_LINEFEED, true, false);
    // Treat multi-codepoint grapheme clusters (emoji ZWJ, Indic scripts) as one cell.
    this.setMode(MODE_GRAPHEME_CLUSTER, false, true);

    this.resetCaches();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    const { runtime } = this;
    const ptr = runtime.alloc(bytes.length);
    runtime.u8().set(bytes, ptr);
    runtime.exports.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    runtime.free(ptr, bytes.length);
    this.stale = true;
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this.runtime.check(
      this.runtime.exports.ghostty_terminal_resize(this.handle, cols, rows, 0, 0),
      'resize'
    );
    this._cols = cols;
    this._rows = rows;
    this.resetCaches();
  }

  free(): void {
    const { runtime } = this;
    const { exports } = runtime;
    runtime.terminals.delete(this.handle);
    if (this.graphemeBufferPtr) runtime.free(this.graphemeBufferPtr, this.graphemeBufferLen * 4);
    this.graphemeBufferPtr = 0;
    runtime.free(this.scratch.base, this.scratch.size);
    exports.ghostty_render_state_row_cells_free(this.rowCells);
    exports.ghostty_render_state_row_iterator_free(this.rowIterator);
    exports.ghostty_render_state_free(this.renderState);
    exports.ghostty_terminal_free(this.handle);
  }

  // ==========================================================================
  // RenderState API
  // ==========================================================================

  /**
   * Sync the render state with the terminal and return the accumulated dirty
   * state (full/partial/none). Safe to call multiple times - dirty state
   * persists until markClean(). Screen switches (normal <-> alternate) always
   * report FULL.
   */
  update(): DirtyState {
    if (this.stale) this.sync();
    return this.dirty;
  }

  getCursor(): RenderStateCursor {
    this.update();
    const { runtime } = this;
    const { k } = runtime;
    const out = this.scratch.out;
    let x: number;
    let y: number;
    if (this.renderGet(k.RS_CURSOR_VIEWPORT_HAS_VALUE) && runtime.u8()[out]) {
      x = this.renderGetU16(k.RS_CURSOR_VIEWPORT_X);
      y = this.renderGetU16(k.RS_CURSOR_VIEWPORT_Y);
    } else {
      x = this.terminalGetU16(k.DATA_CURSOR_X);
      y = this.terminalGetU16(k.DATA_CURSOR_Y);
    }
    const visible = this.renderGet(k.RS_CURSOR_VISIBLE) && runtime.u8()[out] !== 0;
    return {
      x,
      y,
      viewportX: x,
      viewportY: y,
      visible,
      blinking: false, // TODO: Add blinking support
      style: 'block', // TODO: Add style support
    };
  }

  getColors(): RenderStateColors {
    this.update();
    return {
      background: { ...this.defaultBg },
      foreground: { ...this.defaultFg },
      cursor: null, // TODO: Add cursor color support
    };
  }

  isRowDirty(y: number): boolean {
    this.update();
    return this.dirty === DirtyState.FULL || this.rowDirty[y] === 1;
  }

  markClean(): void {
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(0);
  }

  /**
   * Get all viewport cells (rows * cols, row-major).
   * Returns a reused array of cached cell objects; do not mutate.
   */
  getViewport(): GhosttyCell[] {
    this.update();
    let i = 0;
    for (const row of this.rowCache) {
      for (const cell of row) this.cellPool[i++] = cell;
    }
    this.cellPool.length = i;
    return this.cellPool;
  }

  // ==========================================================================
  // Compatibility methods
  // ==========================================================================

  /** Get a copy of one viewport row's cells. */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    this.update();
    return this.rowCache[y].map((cell) => ({ ...cell }));
  }

  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    return (
      this.terminalGetU32(this.runtime.k.DATA_ACTIVE_SCREEN) === this.runtime.k.SCREEN_ALTERNATE
    );
  }

  hasBracketedPaste(): boolean {
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    return this.getMode(1004, false);
  }

  /** Normal (1000), button-event (1002) or any-event (1003) mouse tracking. */
  hasMouseTracking(): boolean {
    return this.getMode(1000, false) || this.getMode(1002, false) || this.getMode(1003, false);
  }

  /**
   * Query a terminal mode by number.
   * @param isAnsi True for ANSI modes, false for DEC private modes (default)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    const { runtime } = this;
    const { k } = runtime;
    const ptr = this.writeModeConfig(mode, isAnsi, false);
    if (runtime.exports.ghostty_terminal_get(this.handle, k.DATA_MODE, ptr) !== k.SUCCESS) {
      return false;
    }
    return runtime.u8()[ptr + k.MODE_CONFIG_VALUE] !== 0;
  }

  // ==========================================================================
  // Extended API (scrollback, hyperlinks, responses)
  // ==========================================================================

  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Number of scrollback lines (history, not including the active screen). */
  getScrollbackLength(): number {
    return this.terminalGetU32(this.runtime.k.DATA_SCROLLBACK_ROWS);
  }

  /**
   * Get a line from the scrollback buffer.
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) return null;
    this.update(); // fresh default colors and palette
    if (!this.gridRef(this.runtime.k.POINT_HISTORY, 0, offset)) return null;
    const cells: GhosttyCell[] = [];
    for (let x = 0; x < this._cols; x++) {
      this.setGridRefX(x);
      cells.push(this.readGridCell());
    }
    return cells;
  }

  /** Whether an active-screen row continues the previous (soft-wrapped) row. */
  isRowWrapped(row: number): boolean {
    const { runtime } = this;
    const { exports, k } = runtime;
    if (!this.gridRef(k.POINT_ACTIVE, 0, row)) return false;
    const out = this.scratch.out;
    if (exports.ghostty_grid_ref_row(this.scratch.gridRef, out) !== k.SUCCESS) return false;
    const rawRow = runtime.view().getBigUint64(out, true);
    if (exports.ghostty_row_get(rawRow, k.ROW_WRAP_CONTINUATION, out) !== k.SUCCESS) return false;
    return runtime.u8()[out] !== 0;
  }

  /**
   * Get the hyperlink URI for a cell in the active viewport.
   * @returns The URI string, or null if no hyperlink at that position
   */
  getHyperlinkUri(row: number, col: number): string | null {
    return this.hyperlinkAt(this.runtime.k.POINT_ACTIVE, col, row);
  }

  /**
   * Get the hyperlink URI for a cell in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest)
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.hyperlinkAt(this.runtime.k.POINT_HISTORY, col, offset);
  }

  /**
   * Whether replies are waiting to be sent to the PTY.
   * Replies are generated by queries such as DSR, DA and DECRQM.
   */
  hasResponse(): boolean {
    return this.responses.length > 0;
  }

  /**
   * Take all pending replies as one string, or null if none. Replies to
   * queries from a single write are sent together, as a native terminal
   * would, so programs reading them with one read() get all of them.
   */
  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    const data = this.responses.join('');
    this.responses = [];
    return data;
  }

  /** @internal Called by the WRITE_PTY callback. */
  queueResponse(data: string): void {
    this.responses.push(data);
  }

  /**
   * Get all codepoints for the grapheme cluster at a viewport position.
   * Most cells hold one codepoint; complex scripts and emoji sequences hold more.
   */
  getGrapheme(row: number, col: number): number[] | null {
    if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) return null;
    this.update();
    const cached = this.graphemes.get(row * this._cols + col);
    if (cached) return [...cached];
    const cell = this.rowCache[row][col];
    return cell.codepoint ? [cell.codepoint] : [];
  }

  getGraphemeString(row: number, col: number): string {
    const codepoints = this.getGrapheme(row, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  /** Get all codepoints for a grapheme cluster in the scrollback buffer. */
  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    if (col < 0 || col >= this._cols) return null;
    if (!this.gridRef(this.runtime.k.POINT_HISTORY, col, offset)) return null;
    return this.readGridGraphemes();
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    const codepoints = this.getScrollbackGrapheme(offset, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  // ==========================================================================
  // Render state sync
  // ==========================================================================

  private sync(): void {
    this.stale = false;
    const { runtime, scratch } = this;
    const { exports, k } = runtime;

    runtime.check(
      exports.ghostty_render_state_update(this.renderState, this.handle),
      'render update'
    );
    this.readColors();

    const screen = this.terminalGetU32(k.DATA_ACTIVE_SCREEN);
    const screenSwitched = screen !== this.lastScreen;
    this.lastScreen = screen;

    this.renderGet(k.RS_DIRTY);
    const state = runtime.view().getInt32(scratch.out, true);
    const full = this.needsFullRead || screenSwitched || state === k.DIRTY_FULL;
    if (state === k.DIRTY_FALSE && !full) return;

    const view = runtime.view();
    view.setUint32(scratch.rowIteratorSlot, this.rowIterator, true);
    runtime.check(
      exports.ghostty_render_state_get(
        this.renderState,
        k.RS_ROW_ITERATOR,
        scratch.rowIteratorSlot
      ),
      'row iterator'
    );

    if (full) {
      this.graphemes.clear();
      for (
        let y = 0;
        y < this._rows && exports.ghostty_render_state_row_iterator_next(this.rowIterator);
        y++
      ) {
        this.readRow(y);
      }
      this.dirty = DirtyState.FULL;
    } else {
      while (exports.ghostty_render_state_row_iterator_next_dirty(this.rowIterator, scratch.outY)) {
        const y = runtime.view().getUint16(scratch.outY, true);
        if (y >= this._rows) continue;
        this.readRow(y);
        this.rowDirty[y] = 1;
      }
      if (this.dirty === DirtyState.NONE) this.dirty = DirtyState.PARTIAL;
    }
    this.needsFullRead = false;
    exports.ghostty_render_state_clean(this.renderState);
  }

  private readColors(): void {
    const { runtime, scratch } = this;
    const { k } = runtime;
    const ptr = scratch.colors;
    runtime.view().setUint32(ptr, k.COLORS_SIZE, true);
    runtime.check(
      runtime.exports.ghostty_render_state_get(this.renderState, k.RS_COLORS, ptr),
      'render colors'
    );
    const u8 = runtime.u8();
    this.defaultBg = readRgb(u8, ptr + k.COLORS_BACKGROUND);
    this.defaultFg = readRgb(u8, ptr + k.COLORS_FOREGROUND);
    this.palette.set(u8.subarray(ptr + k.COLORS_PALETTE, ptr + k.COLORS_PALETTE + 256 * 3));
  }

  /** Read the iterator's current row into rowCache[y]. */
  private readRow(y: number): void {
    const { runtime, scratch } = this;
    const { exports, k } = runtime;
    runtime.view().setUint32(scratch.rowCellsSlot, this.rowCells, true);
    runtime.check(
      exports.ghostty_render_state_row_get(this.rowIterator, k.ROW_CELLS, scratch.rowCellsSlot),
      'row cells'
    );

    // Per-cell multi query: [raw cell (u64), grapheme count (u32), has styling (bool)].
    const view = runtime.view();
    const keys = scratch.keys;
    const values = scratch.values;
    const multi = scratch.multi;
    view.setInt32(keys, k.CELLS_RAW, true);
    view.setInt32(keys + 4, k.CELLS_GRAPHEMES_LEN, true);
    view.setInt32(keys + 8, k.CELLS_HAS_STYLING, true);
    view.setUint32(values, multi, true);
    view.setUint32(values + 4, multi + 8, true);
    view.setUint32(values + 8, multi + 16, true);

    const row = this.rowCache[y];
    for (let x = 0; x < this._cols; x++) {
      const cell = row[x];
      if (!exports.ghostty_render_state_row_cells_next(this.rowCells)) {
        this.setBlank(cell);
        continue;
      }
      exports.ghostty_render_state_row_cells_get_multi(this.rowCells, 3, keys, values, 0);
      const v = runtime.view();
      const raw = v.getBigUint64(multi, true);
      const graphemeLen = v.getUint32(multi + 8, true);
      const styled = runtime.u8()[multi + 16] !== 0;
      const contentTag = this.readRawCell(raw, cell);

      cell.grapheme_len = graphemeLen > 1 ? Math.min(graphemeLen - 1, 255) : 0;
      if (cell.grapheme_len > 0) {
        this.graphemes.set(y * this._cols + x, this.readRowCellGraphemes(graphemeLen));
      } else {
        this.graphemes.delete(y * this._cols + x);
      }

      cell.flags = styled ? this.readRowCellStyleFlags() : 0;
      const fg = styled ? this.rowCellColor(k.CELLS_FG_COLOR) : null;
      const bg =
        styled || contentTag === k.CONTENT_BG_PALETTE || contentTag === k.CONTENT_BG_RGB
          ? this.rowCellColor(k.CELLS_BG_COLOR)
          : null;
      setRgb(cell, 'fg', fg ?? this.defaultFg);
      setRgb(cell, 'bg', bg ?? this.defaultBg);
    }
  }

  /** Fill codepoint, width and hyperlink from a raw cell; returns its content tag. */
  private readRawCell(raw: bigint, cell: GhosttyCell): number {
    const { runtime, scratch } = this;
    const { exports, k } = runtime;
    const keys = scratch.keys + 16;
    const values = scratch.values + 16;
    const out = scratch.multi + 24;
    const view = runtime.view();
    view.setInt32(keys, k.CELL_CODEPOINT, true);
    view.setInt32(keys + 4, k.CELL_WIDE, true);
    view.setInt32(keys + 8, k.CELL_HAS_HYPERLINK, true);
    view.setInt32(keys + 12, k.CELL_CONTENT_TAG, true);
    view.setUint32(values, out, true);
    view.setUint32(values + 4, out + 4, true);
    view.setUint32(values + 8, out + 8, true);
    view.setUint32(values + 12, out + 12, true);
    exports.ghostty_cell_get_multi(raw, 4, keys, values, 0);
    const v = runtime.view();
    cell.codepoint = v.getUint32(out, true);
    const wide = v.getInt32(out + 4, true);
    cell.width =
      wide === k.WIDE_WIDE ? 2 : wide === k.WIDE_SPACER_TAIL || wide === k.WIDE_SPACER_HEAD ? 0 : 1;
    cell.hyperlink_id = runtime.u8()[out + 8] !== 0 ? 1 : 0;
    return v.getInt32(out + 12, true);
  }

  private readRowCellStyleFlags(): number {
    const { runtime, scratch } = this;
    const { k } = runtime;
    runtime.view().setUint32(scratch.style, k.STYLE_SIZE, true);
    runtime.exports.ghostty_render_state_row_cells_get(this.rowCells, k.CELLS_STYLE, scratch.style);
    return styleFlags(runtime, scratch.style);
  }

  private rowCellColor(key: number): RGB | null {
    const { runtime, scratch } = this;
    const out = scratch.out;
    if (
      runtime.exports.ghostty_render_state_row_cells_get(this.rowCells, key, out) !==
      runtime.k.SUCCESS
    ) {
      return null;
    }
    return readRgb(runtime.u8(), out);
  }

  private readRowCellGraphemes(count: number): number[] {
    const ptr = this.graphemeBuffer(count);
    this.runtime.exports.ghostty_render_state_row_cells_get(
      this.rowCells,
      this.runtime.k.CELLS_GRAPHEMES_BUF,
      ptr
    );
    return Array.from(new Uint32Array(this.runtime.exports.memory.buffer, ptr, count));
  }

  // ==========================================================================
  // Grid references (scrollback, wrap flags, hyperlinks)
  // ==========================================================================

  /** Resolve a point into scratch.gridRef. */
  private gridRef(tag: number, x: number, y: number): boolean {
    const { runtime, scratch } = this;
    const { k } = runtime;
    const view = runtime.view();
    runtime.u8().fill(0, scratch.point, scratch.point + k.POINT_SIZE);
    view.setInt32(scratch.point + k.POINT_TAG, tag, true);
    view.setUint16(scratch.point + k.POINT_X, x, true);
    view.setUint32(scratch.point + k.POINT_Y, y, true);
    view.setUint32(scratch.gridRef, k.GRID_REF_SIZE, true);
    return (
      runtime.exports.ghostty_terminal_grid_ref(this.handle, scratch.point, scratch.gridRef) ===
      k.SUCCESS
    );
  }

  /**
   * Move scratch.gridRef to another column of the same row. Resolving a
   * history point walks the scrollback page list, so a row is resolved once
   * and its cells are addressed through the ref's public x field.
   */
  private setGridRefX(x: number): void {
    this.runtime.view().setUint16(this.scratch.gridRef + this.runtime.k.GRID_REF_X, x, true);
  }

  private readGridCell(): GhosttyCell {
    const { runtime, scratch } = this;
    const { exports, k } = runtime;
    const cell = blankCell(this.defaultFg, this.defaultBg);
    const out = scratch.out;
    if (exports.ghostty_grid_ref_cell(scratch.gridRef, out) !== k.SUCCESS) return cell;
    const raw = runtime.view().getBigUint64(out, true);
    const contentTag = this.readRawCell(raw, cell);

    if (contentTag === k.CONTENT_CODEPOINT_GRAPHEME) {
      const codepoints = this.readGridGraphemes();
      cell.grapheme_len =
        codepoints && codepoints.length > 1 ? Math.min(codepoints.length - 1, 255) : 0;
    }

    let bg: RGB | null = null;
    if (contentTag === k.CONTENT_BG_PALETTE) {
      if (exports.ghostty_cell_get(raw, k.CELL_COLOR_PALETTE, out) === k.SUCCESS) {
        bg = this.paletteColor(runtime.u8()[out]);
      }
    } else if (contentTag === k.CONTENT_BG_RGB) {
      if (exports.ghostty_cell_get(raw, k.CELL_COLOR_RGB, out) === k.SUCCESS) {
        bg = readRgb(runtime.u8(), out);
      }
    }

    exports.ghostty_cell_get(raw, k.CELL_HAS_STYLING, out);
    if (runtime.u8()[out] !== 0) {
      runtime.view().setUint32(scratch.style, k.STYLE_SIZE, true);
      if (exports.ghostty_grid_ref_style(scratch.gridRef, scratch.style) === k.SUCCESS) {
        cell.flags = styleFlags(runtime, scratch.style);
        const fg = this.styleColor(scratch.style + k.STYLE_FG);
        if (fg) setRgb(cell, 'fg', fg);
        bg = this.styleColor(scratch.style + k.STYLE_BG) ?? bg;
      }
    }
    if (bg) setRgb(cell, 'bg', bg);
    return cell;
  }

  private readGridGraphemes(): number[] | null {
    const { runtime, scratch } = this;
    const { exports, k } = runtime;
    let capacity = Math.max(this.graphemeBufferLen, 16);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ptr = this.graphemeBuffer(capacity);
      const result = exports.ghostty_grid_ref_graphemes(
        scratch.gridRef,
        ptr,
        capacity,
        scratch.out
      );
      const len = runtime.view().getUint32(scratch.out, true);
      if (result === k.SUCCESS) {
        return Array.from(new Uint32Array(exports.memory.buffer, ptr, len));
      }
      if (result !== k.OUT_OF_SPACE) return null;
      capacity = len;
    }
    return null;
  }

  private hyperlinkAt(tag: number, col: number, row: number): string | null {
    const { runtime, scratch } = this;
    const { exports, k } = runtime;
    if (!this.gridRef(tag, col, row)) return null;
    let capacity = 2048;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ptr = runtime.alloc(capacity);
      try {
        const result = exports.ghostty_grid_ref_hyperlink_uri(
          scratch.gridRef,
          ptr,
          capacity,
          scratch.out
        );
        const len = runtime.view().getUint32(scratch.out, true);
        if (result === k.SUCCESS) {
          return len === 0 ? null : new TextDecoder().decode(runtime.u8().slice(ptr, ptr + len));
        }
        if (result !== k.OUT_OF_SPACE) return null;
        capacity = len;
      } finally {
        runtime.free(ptr, capacity);
      }
    }
    return null;
  }

  /** Resolve a GhosttyStyleColor; null means "use the default color". */
  private styleColor(ptr: number): RGB | null {
    const { runtime } = this;
    const { k } = runtime;
    const tag = runtime.view().getInt32(ptr + k.COLOR_TAG, true);
    if (tag === k.COLOR_TAG_PALETTE)
      return this.paletteColor(runtime.u8()[ptr + k.COLOR_PALETTE_INDEX]);
    if (tag === k.COLOR_TAG_RGB) return readRgb(runtime.u8(), ptr + k.COLOR_RGB);
    return null;
  }

  private paletteColor(index: number): RGB {
    const p = this.palette;
    return { r: p[index * 3], g: p[index * 3 + 1], b: p[index * 3 + 2] };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private setOption(option: number, value: number): void {
    this.runtime.check(
      this.runtime.exports.ghostty_terminal_set(this.handle, option, value),
      `terminal option ${option}`
    );
  }

  private setMode(mode: number, isAnsi: boolean, value: boolean): void {
    const ptr = this.writeModeConfig(mode, isAnsi, value);
    this.setOption(this.runtime.k.OPT_MODE, ptr);
  }

  private writeModeConfig(mode: number, isAnsi: boolean, value: boolean): number {
    const { runtime } = this;
    const { k } = runtime;
    const ptr = this.scratch.modeConfig;
    const view = runtime.view();
    view.setUint16(ptr + k.MODE_CONFIG_MODE, (mode & 0x7fff) | (isAnsi ? 0x8000 : 0), true);
    view.setUint8(ptr + k.MODE_CONFIG_VALUE, value ? 1 : 0);
    return ptr;
  }

  private applyConfig(config: GhosttyTerminalConfig | undefined): void {
    const { runtime } = this;
    const { exports, k } = runtime;

    // Scrollback is a line limit (xterm.js semantics); 0 means unlimited.
    // libghostty-vt also caps scrollback at 10,000 *bytes* by default, which
    // keeps only about one page (~1,000 lines), so drop the byte limit.
    this.setOption(k.OPT_SCROLLBACK_MAX_BYTES, 0);
    const lines = config?.scrollbackLimit ?? DEFAULT_SCROLLBACK_LINES;
    if (lines === 0) {
      this.setOption(k.OPT_SCROLLBACK_MAX_LINES, 0);
    } else {
      runtime.view().setUint32(this.scratch.out, lines, true);
      this.setOption(k.OPT_SCROLLBACK_MAX_LINES, this.scratch.out);
    }

    if (!config) return;
    // Colors use 0xRRGGBB; 0 keeps the library default.
    const setColor = (option: number, rgb: number | undefined) => {
      if (!rgb) return;
      writeRgb(runtime.u8(), this.scratch.out, rgb);
      this.setOption(option, this.scratch.out);
    };
    setColor(k.OPT_COLOR_FOREGROUND, config.fgColor);
    setColor(k.OPT_COLOR_BACKGROUND, config.bgColor);
    setColor(k.OPT_COLOR_CURSOR, config.cursorColor);

    if (config.palette?.some((rgb) => rgb)) {
      const ptr = runtime.alloc(256 * 3);
      try {
        exports.ghostty_color_palette_default(ptr);
        config.palette.slice(0, 256).forEach((rgb, i) => {
          if (rgb) writeRgb(runtime.u8(), ptr + i * 3, rgb);
        });
        this.setOption(k.OPT_COLOR_PALETTE, ptr);
      } finally {
        runtime.free(ptr, 256 * 3);
      }
    }
  }

  private resetCaches(): void {
    const total = this._cols * this._rows;
    this.rowCache = [];
    for (let y = 0; y < this._rows; y++) {
      const row: GhosttyCell[] = [];
      for (let x = 0; x < this._cols; x++) row.push(blankCell(this.defaultFg, this.defaultBg));
      this.rowCache.push(row);
    }
    this.cellPool = new Array(total);
    this.rowDirty = new Uint8Array(this._rows);
    this.graphemes.clear();
    this.needsFullRead = true;
    this.stale = true;
    this.dirty = DirtyState.FULL;
  }

  private setBlank(cell: GhosttyCell): void {
    Object.assign(cell, blankCell(this.defaultFg, this.defaultBg));
  }

  private graphemeBuffer(count: number): number {
    if (count > this.graphemeBufferLen) {
      if (this.graphemeBufferPtr)
        this.runtime.free(this.graphemeBufferPtr, this.graphemeBufferLen * 4);
      this.graphemeBufferLen = Math.max(count, 16);
      this.graphemeBufferPtr = this.runtime.alloc(this.graphemeBufferLen * 4);
    }
    return this.graphemeBufferPtr;
  }

  private renderGet(key: number): boolean {
    return (
      this.runtime.exports.ghostty_render_state_get(this.renderState, key, this.scratch.out) ===
      this.runtime.k.SUCCESS
    );
  }

  private renderGetU16(key: number): number {
    return this.renderGet(key) ? this.runtime.view().getUint16(this.scratch.out, true) : 0;
  }

  private terminalGetU16(key: number): number {
    const { runtime } = this;
    const ok =
      runtime.exports.ghostty_terminal_get(this.handle, key, this.scratch.out) ===
      runtime.k.SUCCESS;
    return ok ? runtime.view().getUint16(this.scratch.out, true) : 0;
  }

  private terminalGetU32(key: number): number {
    const { runtime } = this;
    const ok =
      runtime.exports.ghostty_terminal_get(this.handle, key, this.scratch.out) ===
      runtime.k.SUCCESS;
    return ok ? runtime.view().getUint32(this.scratch.out, true) : 0;
  }
}

function styleFlags(runtime: Runtime, ptr: number): number {
  const { k } = runtime;
  const u8 = runtime.u8();
  let flags = 0;
  for (const [offset, flag] of k.STYLE_FLAGS) {
    if (u8[ptr + offset] !== 0) flags |= flag;
  }
  if (runtime.view().getInt32(ptr + k.STYLE_UNDERLINE, true) !== 0) flags |= CellFlags.UNDERLINE;
  return flags;
}

function readRgb(u8: Uint8Array, ptr: number): RGB {
  return { r: u8[ptr], g: u8[ptr + 1], b: u8[ptr + 2] };
}

function writeRgb(u8: Uint8Array, ptr: number, rgb: number): void {
  u8[ptr] = (rgb >> 16) & 0xff;
  u8[ptr + 1] = (rgb >> 8) & 0xff;
  u8[ptr + 2] = rgb & 0xff;
}

function setRgb(cell: GhosttyCell, which: 'fg' | 'bg', rgb: RGB): void {
  if (which === 'fg') {
    cell.fg_r = rgb.r;
    cell.fg_g = rgb.g;
    cell.fg_b = rgb.b;
  } else {
    cell.bg_r = rgb.r;
    cell.bg_g = rgb.g;
    cell.bg_b = rgb.b;
  }
}

function blankCell(fg: RGB, bg: RGB): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: fg.r,
    fg_g: fg.g,
    fg_b: fg.b,
    bg_r: bg.r,
    bg_g: bg.g,
    bg_b: bg.b,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

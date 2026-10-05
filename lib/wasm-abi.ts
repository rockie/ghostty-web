/**
 * Runtime view of the libghostty-vt WebAssembly ABI.
 *
 * Struct offsets, sizes and enum values are read from ghostty_type_json(), the
 * layout description libghostty-vt ships for dynamic-language hosts. Nothing
 * here hardcodes upstream numbering, so a library update that reorders fields
 * or renumbers enums keeps working, and one that removes something we rely on
 * fails at load time instead of silently reading the wrong memory.
 */

interface FieldInfo {
  offset: number;
  size: number;
  type: string;
}

interface TypeInfo {
  kind: string;
  size?: number;
  fields?: Record<string, FieldInfo>;
  values?: Record<string, number>;
}

interface TypeLayout {
  abi: { pointer_size: number; usize_size: number; endian: string };
  types: Record<string, TypeInfo>;
}

export interface AbiExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  ghostty_type_json(): number;
}

export class WasmAbi {
  private readonly layout: TypeLayout;

  constructor(exports: AbiExports) {
    const bytes = new Uint8Array(exports.memory.buffer);
    const start = exports.ghostty_type_json();
    let end = start;
    while (bytes[end] !== 0) end++;
    this.layout = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));

    const { abi } = this.layout;
    if (abi.pointer_size !== 4 || abi.usize_size !== 4 || abi.endian !== 'little') {
      throw new Error(`Unsupported libghostty-vt ABI: ${JSON.stringify(abi)}`);
    }
  }

  private type(name: string): TypeInfo {
    const info = this.layout.types[name];
    if (!info) throw new Error(`libghostty-vt ABI is missing type ${name}`);
    return info;
  }

  /** Numeric value of an enum member, e.g. enumValue('GhosttyTerminalData', 'COLS'). */
  enumValue(type: string, member: string): number {
    const value = this.type(type).values?.[member];
    if (value === undefined) throw new Error(`libghostty-vt ABI is missing ${type}.${member}`);
    return value;
  }

  /** All members of an enum, keyed by name. */
  enumValues(type: string): Record<string, number> {
    const values = this.type(type).values;
    if (!values) throw new Error(`libghostty-vt ABI type ${type} is not an enum`);
    return values;
  }

  size(type: string): number {
    const size = this.type(type).size;
    if (size === undefined) throw new Error(`libghostty-vt ABI type ${type} has no size`);
    return size;
  }

  /** Byte offset of a (possibly nested, dot-separated) field, e.g. 'fg_color.tag'. */
  offset(type: string, path: string): number {
    let offset = 0;
    let current = type;
    for (const name of path.split('.')) {
      const field = this.type(current).fields?.[name];
      if (!field) throw new Error(`libghostty-vt ABI is missing field ${type}.${path}`);
      offset += field.offset;
      current = field.type;
    }
    return offset;
  }
}

/**
 * Lets libghostty-vt call JavaScript through its exported function table.
 *
 * Tables only accept WebAssembly functions, so each JS callback is wrapped in
 * a tiny generated module that imports it and re-exports it (the same trick
 * Emscripten's addFunction uses). All parameters are i32 (pointers and
 * handles on wasm32); the result is either void or i32.
 */
export class CallbackTable {
  private readonly table: WebAssembly.Table;
  private readonly modules = new Map<string, WebAssembly.Module>();
  private readonly free: number[] = [];

  constructor(exports: AbiExports) {
    this.table = exports.__indirect_function_table;
  }

  add(fn: (...args: number[]) => unknown, params: number, returnsI32: boolean): number {
    const key = `${params}:${returnsI32}`;
    let module = this.modules.get(key);
    if (!module) {
      module = new WebAssembly.Module(trampolineBytes(params, returnsI32));
      this.modules.set(key, module);
    }
    const wrapped = new WebAssembly.Instance(module, { e: { f: fn } }).exports.f;
    const index = this.free.pop() ?? this.table.grow(1);
    this.table.set(index, wrapped);
    return index;
  }

  remove(index: number): void {
    this.table.set(index, null);
    this.free.push(index);
  }
}

function trampolineBytes(params: number, returnsI32: boolean): Uint8Array<ArrayBuffer> {
  const I32 = 0x7f;
  const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
  const funcType = [
    0x60,
    ...uleb(params),
    ...new Array(params).fill(I32),
    ...(returnsI32 ? [1, I32] : [0]),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    // type section: one function type
    ...section(1, [1, ...funcType]),
    // import section: function "e"."f" of type 0
    ...section(2, [1, 1, 0x65, 1, 0x66, 0x00, 0]),
    // export section: re-export function 0 as "f"
    ...section(7, [1, 1, 0x66, 0x00, 0]),
  ]);
}

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

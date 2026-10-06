/**
 * Binding tests for the upstream libghostty-vt C API: terminal replies,
 * cell decoding (styles, colors, wide cells, graphemes, hyperlinks),
 * scrollback, modes, dirty tracking and key encoding.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from './ghostty';
import { Key, KeyAction, KittyKeyFlags, Mods } from './types';

let ghostty: Ghostty;

beforeAll(async () => {
  ghostty = await Ghostty.load();
});

function text(cells: GhosttyCell[] | null): string {
  return (cells ?? [])
    .filter((cell) => cell.width !== 0)
    .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
    .join('')
    .trimEnd();
}

function rgb(cell: GhosttyCell, which: 'fg' | 'bg'): [number, number, number] {
  return which === 'fg' ? [cell.fg_r, cell.fg_g, cell.fg_b] : [cell.bg_r, cell.bg_g, cell.bg_b];
}

function withTerminal(
  cols: number,
  rows: number,
  fn: (term: GhosttyTerminal) => void,
  config?: any
) {
  const term = ghostty.createTerminal(cols, rows, config);
  try {
    fn(term);
  } finally {
    term.free();
  }
}

function responses(term: GhosttyTerminal): string[] {
  const out: string[] = [];
  for (let r = term.readResponse(); r !== null; r = term.readResponse()) out.push(r);
  return out;
}

describe('terminal replies', () => {
  test('DSR cursor position and operating status', () => {
    withTerminal(20, 5, (term) => {
      term.write('\r\nabc\x1b[6n\x1b[5n');
      // Replies to one write arrive together, like a single PTY write.
      expect(responses(term)).toEqual(['\x1b[2;4R\x1b[0n']);
      expect(term.hasResponse()).toBe(false);
    });
  });

  test('device attributes', () => {
    withTerminal(20, 5, (term) => {
      term.write('\x1b[c\x1b[>c');
      expect(responses(term).join('')).toBe('\x1b[?62;22c\x1b[>1;10;0c');
    });
  });

  test('replies go to the terminal that produced them', () => {
    const a = ghostty.createTerminal(10, 3);
    const b = ghostty.createTerminal(10, 3);
    try {
      b.write('\x1b[5n');
      expect(a.hasResponse()).toBe(false);
      expect(b.readResponse()).toBe('\x1b[0n');
    } finally {
      a.free();
      b.free();
    }
  });
});

describe('cell decoding', () => {
  test('styles and colors', () => {
    withTerminal(
      20,
      3,
      (term) => {
        term.write('\x1b[1;3;4;31mA\x1b[0m\x1b[38;2;10;20;30;48;2;1;2;3mB\x1b[0mC');
        const [a, b, c] = term.getLine(0)!;
        expect(a.flags & CellFlags.BOLD).toBeTruthy();
        expect(a.flags & CellFlags.ITALIC).toBeTruthy();
        expect(a.flags & CellFlags.UNDERLINE).toBeTruthy();
        expect(rgb(a, 'fg')).toEqual([0xaa, 0x11, 0x22]);
        expect(rgb(b, 'fg')).toEqual([10, 20, 30]);
        expect(rgb(b, 'bg')).toEqual([1, 2, 3]);
        expect(c.flags).toBe(0);
        expect(rgb(c, 'fg')).toEqual([0x12, 0x34, 0x56]);
        expect(rgb(c, 'bg')).toEqual([0x65, 0x43, 0x21]);
        expect(term.getColors().foreground).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
      },
      { fgColor: 0x123456, bgColor: 0x654321, palette: [0, 0xaa1122] }
    );
  });

  test('background-only cells from erase', () => {
    withTerminal(10, 3, (term) => {
      term.write('ab\x1b[48;2;9;8;7m\x1b[K');
      const line = term.getLine(0)!;
      expect(rgb(line[9], 'bg')).toEqual([9, 8, 7]);
      expect(line[9].codepoint).toBe(0);
    });
  });

  test('wide characters', () => {
    withTerminal(10, 3, (term) => {
      term.write('中x');
      const line = term.getLine(0)!;
      expect(line[0].codepoint).toBe('中'.codePointAt(0)!);
      expect(line[0].width).toBe(2);
      expect(line[1].width).toBe(0);
      expect(line[2].codepoint).toBe('x'.codePointAt(0)!);
    });
  });

  test('grapheme clusters', () => {
    withTerminal(10, 3, (term) => {
      const family = '👨‍👩‍👧';
      term.write(family);
      const cell = term.getLine(0)![0];
      expect(cell.grapheme_len).toBe([...family].length - 1);
      expect(term.getGraphemeString(0, 0)).toBe(family);
    });
  });

  test('OSC 8 hyperlinks', () => {
    withTerminal(20, 3, (term) => {
      term.write('\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain');
      const line = term.getLine(0)!;
      expect(line[0].hyperlink_id).not.toBe(0);
      expect(line[5].hyperlink_id).toBe(0);
      expect(term.getHyperlinkUri(0, 2)).toBe('https://example.com/a');
      expect(term.getHyperlinkUri(0, 6)).toBeNull();
    });
  });
});

describe('runtime colors', () => {
  test('setColors recolors existing content and resets to defaults', () => {
    withTerminal(10, 3, (term) => {
      term.write('a\x1b[31mb\x1b[0m');
      const defaults = term.getColors();

      term.setColors({ fgColor: 0x112233, bgColor: 0x445566, palette: [0, 0x778899] });
      let [a, b] = term.getLine(0)!;
      expect(rgb(a, 'fg')).toEqual([0x11, 0x22, 0x33]);
      expect(rgb(a, 'bg')).toEqual([0x44, 0x55, 0x66]);
      expect(rgb(b, 'fg')).toEqual([0x77, 0x88, 0x99]);
      expect(term.needsFullRedraw()).toBe(true);

      term.setColors({});
      [a] = term.getLine(0)!;
      expect(term.getColors()).toEqual(defaults);
      expect(rgb(a, 'fg')).toEqual([
        defaults.foreground.r,
        defaults.foreground.g,
        defaults.foreground.b,
      ]);
    });
  });

  test('colors set by the program (OSC 11) keep precedence', () => {
    withTerminal(10, 3, (term) => {
      term.write('\x1b]11;rgb:01/02/03\x1b\\x');
      term.setColors({ bgColor: 0x445566 });
      expect(term.getColors().background).toEqual({ r: 1, g: 2, b: 3 });
    });
  });
});

describe('scrollback', () => {
  test('lines, colors, graphemes and hyperlinks survive into history', () => {
    withTerminal(20, 3, (term) => {
      term.write('\x1b[38;2;1;2;3mred\x1b[0m\r\n');
      term.write('👨‍👩‍👧\r\n');
      term.write('\x1b]8;;https://x.test\x1b\\L\x1b]8;;\x1b\\\r\n');
      for (let i = 0; i < 5; i++) term.write(`line${i}\r\n`);

      const length = term.getScrollbackLength();
      expect(length).toBe(6);
      const first = term.getScrollbackLine(0)!;
      expect(text(first)).toBe('red');
      expect(rgb(first[0], 'fg')).toEqual([1, 2, 3]);
      expect(term.getScrollbackGraphemeString(1, 0)).toBe('👨‍👩‍👧');
      expect(term.getScrollbackLine(1)![0].grapheme_len).toBeGreaterThan(0);
      expect(term.getScrollbackHyperlinkUri(2, 0)).toBe('https://x.test');
      expect(text(term.getScrollbackLine(length - 1))).toBe('line2');
      expect(term.getScrollbackLine(length)).toBeNull();
    });
  });

  test('scrollback limit counts lines, not bytes', () => {
    const write = (term: GhosttyTerminal, count: number) => {
      let data = '';
      for (let i = 1; i <= count; i++) data += `line ${i}\r\n`;
      term.write(data);
    };
    withTerminal(80, 24, (term) => {
      write(term, 5000);
      expect(term.getScrollbackLength()).toBe(5000 - 23);
    });
    withTerminal(
      80,
      24,
      (term) => {
        write(term, 20000);
        // Pruning drops whole pages, so slightly fewer lines than the limit remain.
        expect(term.getScrollbackLength()).toBeLessThanOrEqual(2000);
        expect(term.getScrollbackLength()).toBeGreaterThan(1500);
      },
      { scrollbackLimit: 2000 }
    );
  });

  test('wrapped rows', () => {
    withTerminal(5, 3, (term) => {
      term.write('abcdefg');
      expect(term.isRowWrapped(0)).toBe(false);
      expect(term.isRowWrapped(1)).toBe(true);
    });
  });
});

describe('modes and dirty tracking', () => {
  test('mode queries', () => {
    withTerminal(10, 3, (term) => {
      expect(term.hasBracketedPaste()).toBe(false);
      term.write('\x1b[?2004h\x1b[?1002h');
      expect(term.hasBracketedPaste()).toBe(true);
      expect(term.hasMouseTracking()).toBe(true);
      expect(term.getMode(2027)).toBe(true); // grapheme clustering on by default
      expect(term.getMode(20, true)).toBe(false); // linefeed mode off
    });
  });

  test('alternate screen switch forces a full redraw', () => {
    withTerminal(10, 3, (term) => {
      term.update();
      term.markClean();
      term.write('\x1b[?1049h');
      expect(term.isAlternateScreen()).toBe(true);
      expect(term.needsFullRedraw()).toBe(true);
    });
  });

  test('dirty rows accumulate until markClean', () => {
    withTerminal(10, 4, (term) => {
      term.update();
      term.markClean();
      expect(term.isDirty()).toBe(false);
      term.write('\x1b[3;1Hx');
      expect(term.isRowDirty(2)).toBe(true);
      expect(term.isDirty()).toBe(true);
      term.update();
      expect(term.isRowDirty(2)).toBe(true);
      term.markClean();
      expect(term.isRowDirty(2)).toBe(false);
      expect(text(term.getLine(2))).toBe('x');
    });
  });

  test('resize keeps content readable', () => {
    withTerminal(10, 3, (term) => {
      term.write('hello');
      term.resize(20, 5);
      expect(term.getDimensions()).toEqual({ cols: 20, rows: 5 });
      expect(term.getLine(0)!.length).toBe(20);
      expect(text(term.getLine(0))).toBe('hello');
      expect(term.getViewport().length).toBe(100);
    });
  });
});

describe('key encoder', () => {
  const encode = (key: Key, mods: Mods = Mods.NONE, utf8?: string, flags?: KittyKeyFlags) => {
    const encoder = ghostty.createKeyEncoder();
    try {
      if (flags !== undefined) encoder.setKittyFlags(flags);
      return new TextDecoder().decode(encoder.encode({ action: KeyAction.PRESS, key, mods, utf8 }));
    } finally {
      encoder.dispose();
    }
  };

  test('renamed keys map to libghostty-vt keys', () => {
    expect(encode(Key.UP)).toBe('\x1b[A');
    expect(encode(Key.LEFT, Mods.SHIFT)).toBe('\x1b[1;2D');
    expect(encode(Key.ZERO, Mods.NONE, '0')).toBe('0');
    expect(encode(Key.KP_ENTER)).toBe('\r');
  });

  test('control and kitty encodings', () => {
    expect(encode(Key.C, Mods.CTRL)).toBe('\x03');
    expect(encode(Key.ESCAPE, Mods.NONE, undefined, KittyKeyFlags.DISAMBIGUATE)).toBe('\x1b[27u');
  });
});

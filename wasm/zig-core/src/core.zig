// Zero-dependency Zig 0.17 wasm32-freestanding core kernels for high-performance PWAs:
//   1. strip_ansi  — Single-pass CSI/OSC/ESC ANSI escape stripper
//   2. fuzzy_score — Case-insensitive word-boundary/consecutive fuzzy matcher
//   3. diff_lines  — FNV-1a hashed Myers O(ND) line diff with prefix/suffix trim & max_d guardrail
//
// Memory model: deterministic bump arena inside WASM linear memory (zero GC, zero libc).

const std = @import("std");

// 8 MiB static scratch arena — ample for 32K+ line diffs while keeping binary tiny (BSS = 0 bytes on disk!)
const ARENA_CAP: usize = 8 * 1024 * 1024;
var arena_buf: [ARENA_CAP]u8 align(16) = undefined;
var arena_off: usize = 0;

pub export fn wasm_reset() void {
    arena_off = 0;
}

pub export fn wasm_alloc(n: usize) usize {
    const aligned = (arena_off + 15) & ~@as(usize, 15);
    if (aligned + n > ARENA_CAP) return 0;
    arena_off = aligned + n;
    return @intFromPtr(&arena_buf[aligned]);
}

pub export fn wasm_arena_used() usize {
    return arena_off;
}

pub export fn wasm_arena_cap() usize {
    return ARENA_CAP;
}

// ============================================================================
// 1. ANSI Escape Stripper (CSI, OSC, 2-byte ESC)
// ============================================================================

pub export fn strip_ansi(src_ptr: [*]const u8, src_len: usize, dst_ptr: [*]u8) usize {
    var i: usize = 0;
    var out: usize = 0;
    while (i < src_len) {
        const b = src_ptr[i];
        if (b == 0x1b and i + 1 < src_len) {
            const nxt = src_ptr[i + 1];
            if (nxt == '[') {
                // CSI: ESC [ params intermediate final (0x40..0x7E)
                i += 2;
                while (i < src_len) : (i += 1) {
                    const c = src_ptr[i];
                    if (c >= 0x40 and c <= 0x7e) {
                        i += 1;
                        break;
                    }
                }
                continue;
            } else if (nxt == ']') {
                // OSC: ESC ] ... (BEL 0x07 | ST ESC \)
                i += 2;
                while (i < src_len) : (i += 1) {
                    if (src_ptr[i] == 0x07) {
                        i += 1;
                        break;
                    }
                    if (src_ptr[i] == 0x1b and i + 1 < src_len and src_ptr[i + 1] == '\\') {
                        i += 2;
                        break;
                    }
                }
                continue;
            } else {
                // 2-byte ESC sequence
                i += 2;
                continue;
            }
        }
        dst_ptr[out] = b;
        out += 1;
        i += 1;
    }
    return out;
}

// ============================================================================
// 2. Fuzzy Subsequence Scorer (command palettes, file pickers)
// ============================================================================

inline fn toLower(c: u8) u8 {
    return if (c >= 'A' and c <= 'Z') c + 32 else c;
}

inline fn isBoundary(prev: u8, cur: u8) bool {
    if (prev == '/' or prev == '\\' or prev == '-' or prev == '_' or prev == '.' or prev == ' ') return true;
    if (prev >= 'a' and prev <= 'z' and cur >= 'A' and cur <= 'Z') return true;
    return false;
}

pub export fn fuzzy_score(q_ptr: [*]const u8, q_len: usize, t_ptr: [*]const u8, t_len: usize) i32 {
    if (q_len == 0) return 0;
    if (q_len > t_len) return -1;

    var qi: usize = 0;
    var score: i32 = 0;
    var consecutive: i32 = 0;
    var first_match: usize = 0;
    var matched_any = false;

    var ti: usize = 0;
    while (ti < t_len and qi < q_len) : (ti += 1) {
        const tc = t_ptr[ti];
        if (toLower(tc) == toLower(q_ptr[qi])) {
            if (!matched_any) {
                first_match = ti;
                matched_any = true;
            }
            score += 10;
            if (consecutive > 0) {
                score += 6 + @min(consecutive * 2, 12);
            }
            if (ti == 0 or isBoundary(t_ptr[ti - 1], tc)) {
                score += 14;
            }
            if (tc == q_ptr[qi]) {
                score += 1; // exact-case tiebreaker
            }
            consecutive += 1;
            qi += 1;
        } else {
            consecutive = 0;
        }
    }
    if (qi < q_len) return -1;

    // Reward earlier start and tighter target length
    score -= @as(i32, @intCast(@min(first_match, 32)));
    score -= @as(i32, @intCast(@min(t_len - q_len, 64) >> 2));
    return score;
}

// ============================================================================
// 3. Myers O(ND) Line Diff with FNV-1a Hashing & Guardrail
// ============================================================================

const LineRec = struct {
    off: u32,
    len: u32,
    hash: u64,
};

inline fn fnv1a(buf: [*]const u8, off: u32, len: u32) u64 {
    var h: u64 = 0xcbf29ce484222325;
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        h ^= buf[off + i];
        h *%= 0x100000001b3;
    }
    return h;
}

fn splitLines(buf: [*]const u8, len: usize, out: [*]LineRec, max_lines: usize) usize {
    if (len == 0) return 0;
    var count: usize = 0;
    var start: usize = 0;
    var i: usize = 0;
    while (i < len) : (i += 1) {
        if (buf[i] == '\n') {
            var end = i;
            if (end > start and buf[end - 1] == '\r') end -= 1;
            if (count < max_lines) {
                const off32: u32 = @intCast(start);
                const len32: u32 = @intCast(end - start);
                out[count] = .{ .off = off32, .len = len32, .hash = fnv1a(buf, off32, len32) };
                count += 1;
            }
            start = i + 1;
        }
    }
    // Trailing line only when buffer does NOT end with '\n'
    if (start < len and count < max_lines) {
        var end = len;
        if (end > start and buf[end - 1] == '\r') end -= 1;
        const off32: u32 = @intCast(start);
        const len32: u32 = @intCast(end - start);
        out[count] = .{ .off = off32, .len = len32, .hash = fnv1a(buf, off32, len32) };
        count += 1;
    }
    return count;
}

inline fn linesEqual(
    old_buf: [*]const u8,
    a: LineRec,
    new_buf: [*]const u8,
    b: LineRec,
) bool {
    if (a.hash != b.hash or a.len != b.len) return false;
    var i: u32 = 0;
    while (i < a.len) : (i += 1) {
        if (old_buf[a.off + i] != new_buf[b.off + i]) return false;
    }
    return true;
}

// Packed opcode encoding in u32:
//   bits [31..30]: 0 = EQUAL, 1 = DEL, 2 = ADD, 3 = META/TRUNCATED
//   bits [29..0] : line count
const OP_EQUAL: u32 = 0 << 30;
const OP_DEL: u32 = 1 << 30;
const OP_ADD: u32 = 2 << 30;
const OP_TRUNC: u32 = 3 << 30;

fn pushOp(out: [*]u32, idx: *usize, cap: usize, op: u32, count: u32) void {
    if (count == 0) return;
    if (idx.* > 0 and (out[idx.* - 1] & (3 << 30)) == op) {
        out[idx.* - 1] += count;
        return;
    }
    if (idx.* < cap) {
        out[idx.*] = op | count;
        idx.* += 1;
    }
}

/// Computes unified line diff opcodes between old_buf[0..old_len] and new_buf[0..new_len].
/// Writes run-length packed u32 opcodes to out_ptr[0..out_cap] and returns opcode count (or -1 on OOM).
/// If edit distance exceeds max_d, emits OP_TRUNC followed by clean prefix/del/add/suffix fallback.
pub export fn diff_lines(
    old_ptr: [*]const u8,
    old_len: usize,
    new_ptr: [*]const u8,
    new_len: usize,
    max_d_in: usize,
    out_ptr: [*]u32,
    out_cap: usize,
) i32 {
    const saved_arena = arena_off;
    defer arena_off = saved_arena;

    const MAX_LINES: usize = 32768;
    const old_recs_addr = wasm_alloc(MAX_LINES * @sizeOf(LineRec));
    const new_recs_addr = wasm_alloc(MAX_LINES * @sizeOf(LineRec));
    if (old_recs_addr == 0 or new_recs_addr == 0) return -1;
    const old_recs: [*]LineRec = @ptrFromInt(old_recs_addr);
    const new_recs: [*]LineRec = @ptrFromInt(new_recs_addr);

    const n_total = splitLines(old_ptr, old_len, old_recs, MAX_LINES);
    const m_total = splitLines(new_ptr, new_len, new_recs, MAX_LINES);

    // 1. Common prefix trim
    var prefix: usize = 0;
    while (prefix < n_total and prefix < m_total and linesEqual(old_ptr, old_recs[prefix], new_ptr, new_recs[prefix])) {
        prefix += 1;
    }
    // 2. Common suffix trim
    var suffix: usize = 0;
    while (prefix + suffix < n_total and prefix + suffix < m_total and
        linesEqual(old_ptr, old_recs[n_total - 1 - suffix], new_ptr, new_recs[m_total - 1 - suffix]))
    {
        suffix += 1;
    }

    const n = n_total - prefix - suffix;
    const m = m_total - prefix - suffix;
    var out_n: usize = 0;

    if (n == 0 and m == 0) {
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix + suffix));
        return @intCast(out_n);
    }
    if (n == 0) {
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix));
        pushOp(out_ptr, &out_n, out_cap, OP_ADD, @intCast(m));
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(suffix));
        return @intCast(out_n);
    }
    if (m == 0) {
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix));
        pushOp(out_ptr, &out_n, out_cap, OP_DEL, @intCast(n));
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(suffix));
        return @intCast(out_n);
    }

    // 3. Myers O(ND) on trimmed middle slice [prefix .. prefix+n) vs [prefix .. prefix+m)
    const max_d: usize = @min(max_d_in, @min(n + m, @as(usize, 900)));
    const v_stride: usize = 2 * max_d + 1;
    // Compact triangular trace: step d stores only even offsets (d + 1 entries).
    // Total elements: (max_d + 1) * (max_d + 2) / 2 -> at max_d=900, 1.62 MiB (fits easily in 4 MiB arena).
    const trace_elems: usize = ((max_d + 1) * (max_d + 2)) >> 1;
    const trace_addr = wasm_alloc(trace_elems * @sizeOf(i32));
    const v_addr = wasm_alloc(v_stride * @sizeOf(i32));
    if (trace_addr == 0 or v_addr == 0) {
        pushOp(out_ptr, &out_n, out_cap, OP_TRUNC, 1);
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix));
        pushOp(out_ptr, &out_n, out_cap, OP_DEL, @intCast(n));
        pushOp(out_ptr, &out_n, out_cap, OP_ADD, @intCast(m));
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(suffix));
        return @intCast(out_n);
    }
    const trace: [*]i32 = @ptrFromInt(trace_addr);
    const v: [*]i32 = @ptrFromInt(v_addr);
    for (0..v_stride) |idx| v[idx] = 0;

    var found_d: ?usize = null;
    var d: usize = 0;
    while (d <= max_d) : (d += 1) {
        const t_base = (d * (d + 1)) >> 1;
        var k_signed: isize = -@as(isize, @intCast(d));
        const d_signed: isize = @intCast(d);
        while (k_signed <= d_signed) : (k_signed += 2) {
            const k_idx: usize = @intCast(k_signed + @as(isize, @intCast(max_d)));
            var x: usize = 0;
            if (k_signed == -d_signed or (k_signed != d_signed and v[k_idx - 1] < v[k_idx + 1])) {
                x = @intCast(v[k_idx + 1]);
            } else {
                x = @intCast(v[k_idx - 1] + 1);
            }
            var y: usize = @intCast(@as(isize, @intCast(x)) - k_signed);
            while (x < n and y < m and linesEqual(old_ptr, old_recs[prefix + x], new_ptr, new_recs[prefix + y])) {
                x += 1;
                y += 1;
            }
            v[k_idx] = @intCast(x);
            const t_off: usize = @as(usize, @intCast(k_signed + d_signed)) >> 1;
            trace[t_base + t_off] = @intCast(x);
            if (x == n and y == m) {
                found_d = d;
                break;
            }
        }
        if (found_d != null) break;
    }

    if (found_d == null) {
        // Guardrail fallback: clean delete-all + add-all for trimmed middle
        pushOp(out_ptr, &out_n, out_cap, OP_TRUNC, 1);
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix));
        pushOp(out_ptr, &out_n, out_cap, OP_DEL, @intCast(n));
        pushOp(out_ptr, &out_n, out_cap, OP_ADD, @intCast(m));
        pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(suffix));
        return @intCast(out_n);
    }

    // 4. Backtrack edits in reverse into temporary buffer, then emit forward with RLE!
    const rev_cap = n + m + 4;
    const rev_addr = wasm_alloc(rev_cap * @sizeOf(u32));
    if (rev_addr == 0) return -1;
    const rev: [*]u32 = @ptrFromInt(rev_addr);
    var rev_n: usize = 0;

    var x: isize = @intCast(n);
    var y: isize = @intCast(m);
    var step: isize = @intCast(found_d.?);
    while (step > 0) : (step -= 1) {
        const prev_d: usize = @intCast(step - 1);
        const prev_base = (prev_d * (prev_d + 1)) >> 1;
        const k: isize = x - y;
        const prev_d_s: isize = @intCast(prev_d);

        var prev_k: isize = 0;
        if (k == -step) {
            prev_k = k + 1;
        } else if (k == step) {
            prev_k = k - 1;
        } else {
            const v_left = trace[prev_base + (@as(usize, @intCast(k - 1 + prev_d_s)) >> 1)];
            const v_right = trace[prev_base + (@as(usize, @intCast(k + 1 + prev_d_s)) >> 1)];
            prev_k = if (v_left < v_right) k + 1 else k - 1;
        }
        const prev_x: isize = trace[prev_base + (@as(usize, @intCast(prev_k + prev_d_s)) >> 1)];
        const prev_y: isize = prev_x - prev_k;

        // Diagonal matches after the edit
        var eq_cnt: u32 = 0;
        while (x > prev_x and y > prev_y) {
            x -= 1;
            y -= 1;
            eq_cnt += 1;
        }
        if (eq_cnt > 0 and rev_n < rev_cap) {
            rev[rev_n] = OP_EQUAL | eq_cnt;
            rev_n += 1;
        }
        // The single edit step (DEL if x > prev_x else ADD)
        if (x > prev_x) {
            x -= 1;
            if (rev_n < rev_cap) {
                rev[rev_n] = OP_DEL | 1;
                rev_n += 1;
            }
        } else if (y > prev_y) {
            y -= 1;
            if (rev_n < rev_cap) {
                rev[rev_n] = OP_ADD | 1;
                rev_n += 1;
            }
        }
    }
    if (x > 0 and y > 0 and rev_n < rev_cap) {
        rev[rev_n] = OP_EQUAL | @as(u32, @intCast(x));
        rev_n += 1;
    }

    pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(prefix));
    var ri: usize = rev_n;
    while (ri > 0) {
        ri -= 1;
        const entry = rev[ri];
        pushOp(out_ptr, &out_n, out_cap, entry & (3 << 30), entry & 0x3fffffff);
    }
    pushOp(out_ptr, &out_n, out_cap, OP_EQUAL, @intCast(suffix));
    return @intCast(out_n);
}

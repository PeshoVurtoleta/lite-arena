// lite-arena demo -- physics integration on a Worker thread.
//
// The main thread TRANSFERS the Position/Velocity payload buffers here with
// `postMessage(msg, [x, y, vx, vy])`. Transfer MOVES ownership (zero copy) and
// detaches the sender's views; this worker integrates the gravity well in place
// and transfers the same buffers straight back. When they arrive home the main
// thread `rebind()`s them and draws.
//
// No SharedArrayBuffer, no atomics, no cross-origin isolation. This is exactly
// the cross-thread path that runs inside a Twitch Extension iframe (which cannot
// be COI): plain ArrayBuffer transfers, no COOP/COEP headers required.

self.onmessage = (ev) => {
    const m = ev.data;

    const x = new Float32Array(m.x);
    const y = new Float32Array(m.y);
    const vx = new Float32Array(m.vx);
    const vy = new Float32Array(m.vy);
    const n = m.n, dt = m.dt, gx = m.gx, gy = m.gy, gstr = m.gstr;

    // Identical integration to the main-thread arena backend -- same numbers,
    // just on another thread. SoA over the transferred buffers.
    for (let i = 0; i < n; i++) {
        const dx = gx - x[i], dy = gy - y[i];
        const d2 = dx * dx + dy * dy + 100;
        const f = gstr / d2;
        vx[i] += dx * f;
        vy[i] += dy * f;
        vx[i] *= 0.995;
        vy[i] *= 0.995;
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
    }

    // Transfer the four buffers back (move, zero copy). The main thread rebinds.
    self.postMessage(m, [m.x, m.y, m.vx, m.vy]);
};

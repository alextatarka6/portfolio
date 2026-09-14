// Ring buffer that plays back APU samples pushed from the main thread.
//
// Samples arrive via postMessage rather than a SharedArrayBuffer because
// SharedArrayBuffer needs COOP/COEP headers, which GitHub Pages does not set.
// The worklet reports its fill level back so the emulator loop can speed up or
// slow down slightly to stay locked to the audio clock.

const RING_CAPACITY = 44100 * 2; // stereo pairs — about one second of slack

class GbAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.left = new Float32Array(RING_CAPACITY);
        this.right = new Float32Array(RING_CAPACITY);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        // Held so an underrun decays to the last sample instead of clicking to zero.
        this.lastLeft = 0;
        this.lastRight = 0;
        this.reportCountdown = 0;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (data === 'reset') {
                this.readIndex = 0;
                this.writeIndex = 0;
                this.available = 0;
                return;
            }
            this.push(data);
        };
    }

    push(interleaved) {
        const pairs = interleaved.length / 2;
        for (let i = 0; i < pairs; i++) {
            if (this.available >= RING_CAPACITY) break; // overrun: drop the excess
            this.left[this.writeIndex] = interleaved[i * 2];
            this.right[this.writeIndex] = interleaved[i * 2 + 1];
            this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
            this.available++;
        }
    }

    process(_inputs, outputs) {
        const output = outputs[0];
        const outL = output[0];
        const outR = output.length > 1 ? output[1] : output[0];

        for (let i = 0; i < outL.length; i++) {
            if (this.available > 0) {
                this.lastLeft = this.left[this.readIndex];
                this.lastRight = this.right[this.readIndex];
                this.readIndex = (this.readIndex + 1) % RING_CAPACITY;
                this.available--;
            } else {
                // Underrun — fade the held sample out rather than snapping to silence.
                this.lastLeft *= 0.98;
                this.lastRight *= 0.98;
            }
            outL[i] = this.lastLeft;
            outR[i] = this.lastRight;
        }

        // Report the fill level a few times a second; the main thread uses it to
        // decide whether to run an extra frame or skip one.
        if (--this.reportCountdown <= 0) {
            this.reportCountdown = 8;
            this.port.postMessage(this.available);
        }

        return true;
    }
}

registerProcessor('gb-audio', GbAudioProcessor);

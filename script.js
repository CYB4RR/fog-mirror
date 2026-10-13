// =====================================================
//  fog mirror
//  webcam + mic + canvas
//  blow on the mic to fog up the screen, then draw to wipe it
//  like writing on a steamy window
// =====================================================


// ---------- settings ----------

const settings = {
    micSensitivity: 0.5, // 0 = need to blow properly, 1 = picks up basically anything
    brushSize: 34,
    fogSpeed: 1.3,       // how fast the fog builds up when blowing
    clearSpeed: 0.045,   // how fast the fog fades by itself
};

// fog is split into 8x8px squares instead of doing every single pixel
// way less work (like 64x less) and it gets stretched + smoothed to full size anyway
const CELL_SIZE = 8;


// ---------- canvases ----------
//
// display     -> the one you actually see
// fogLayer    -> blurry milky version of the cam
// fogMask     -> where the fog is (see through = clear glass)
// strokes     -> everything you've drawn
// blurMedium  -> helpers for blurring the cam
// blurSmall
// fogGrid     -> one pixel per fog square

// makes a canvas + its ctx (the "pen" you draw with)
// if you don't give it a canvas it just makes a new one
function createLayer(canvas = document.createElement('canvas')) {
    return { canvas, ctx: canvas.getContext('2d') };
}

const display = createLayer(document.getElementById('screen'));
const fogLayer = createLayer();
const fogMask = createLayer();
const strokes = createLayer();
const blurMedium = createLayer();
const blurSmall = createLayer();
const fogGrid = createLayer();

// hidden video that the webcam feeds into
const video = document.createElement('video');
video.playsInline = true; // stops iphones going fullscreen
video.muted = true;       // so your mic doesn't play back through the speakers


// ---------- state ----------
// these get filled in later once we know the window size

let width, height, pixelRatio;
let gridCols, gridRows;
let fogDensity;  // how foggy each square is, 0 to 1
let fogPattern;  // random noise for each square so the fog isn't perfectly even
let breathShape; // breath hits the middle of the screen the most
let fogImage;    // fogDensity gets written into this every frame
let grainPattern;

let analyser = null;
let audioSamples = null;
let blowStrength = 0;
let spaceHeld = false;

let isDrawing = false;
let lastPoint = null;


// ---------- small helpers ----------

const lerp = (a, b, t) => a + (b - a) * t;                              // blends between 2 numbers
const clamp = (value, min, max) => Math.min(max, Math.max(min, value)); // keeps a number between min and max
const smoothstep = (t) => t * t * (3 - 2 * t);   // makes a blend soft instead of sharp



// ---------- noise (makes the fog look natural) ----------

// random numbers on a rough grid, smoothly blended in between
// bigger spacing = bigger softer blobs
function smoothNoise(cols, rows, spacing) {
    const latticeCols = Math.ceil(cols / spacing) + 2;
    const latticeRows = Math.ceil(rows / spacing) + 2;
    const lattice = Array.from({ length: latticeCols * latticeRows }, Math.random);

    const result = new Float32Array(cols * rows);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const gx = x / spacing;
            const gy = y / spacing;
            const x0 = Math.floor(gx);
            const y0 = Math.floor(gy);
            const tx = smoothstep(gx - x0);
            const ty = smoothstep(gy - y0);

            // the 4 random numbers around this spot
            const topLeft = lattice[y0 * latticeCols + x0];
            const topRight = lattice[y0 * latticeCols + x0 + 1];
            const bottomLeft = lattice[(y0 + 1) * latticeCols + x0];
            const bottomRight = lattice[(y0 + 1) * latticeCols + x0 + 1];

            // blend them together
            const top = lerp(topLeft, topRight, tx);
            const bottom = lerp(bottomLeft, bottomRight, tx);
            result[y * cols + x] = lerp(top, bottom, ty);
        }
    }
    return result;
}

// mixes big, medium and small blobs then stretches it to 0..1
function makeFogPattern(cols, rows) {
    const big = smoothNoise(cols, rows, 16);
    const medium = smoothNoise(cols, rows, 6);
    const small = smoothNoise(cols, rows, 2);

    const pattern = new Float32Array(cols * rows);
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < pattern.length; i++) {
        pattern[i] = 0.55 * big[i] + 0.3 * medium[i] + 0.15 * small[i];
        min = Math.min(min, pattern[i]);
        max = Math.max(max, pattern[i]);
    }
    for (let i = 0; i < pattern.length; i++) {
        pattern[i] = (pattern[i] - min) / (max - min || 1);
    }
    return pattern;
}

// tiny speckles + random droplets that get tiled over the fog
// each pixel is 4 numbers (red, green, blue, alpha) which is why it goes up by 4
function makeGrainPattern() {
    const grain = createLayer();
    grain.canvas.width = 256;
    grain.canvas.height = 256;

    const image = grain.ctx.createImageData(256, 256);
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 255;
        image.data[i + 1] = 255;
        image.data[i + 2] = 255;

        const isDroplet = Math.random() > 0.985;
        image.data[i + 3] = isDroplet ? 50 + Math.random() * 90 : Math.random() * 14;
    }
    grain.ctx.putImageData(image, 0, 0);

    return fogLayer.ctx.createPattern(grain.canvas, 'repeat');
}


// ---------- sizing ----------

function copyCanvas(source) {
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d').drawImage(source, 0, 0);
    return copy;
}

function setupSize() {
    // max 2x so really sharp screens don't get laggy
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = window.innerWidth;
    const cssHeight = window.innerHeight;
    width = Math.round(cssWidth * pixelRatio);
    height = Math.round(cssHeight * pixelRatio);

    // resizing a canvas wipes it so save the drawing first
    const savedStrokes = copyCanvas(strokes.canvas);

    for (const layer of [display, fogLayer, fogMask, strokes]) {
        layer.canvas.width = width;
        layer.canvas.height = height;
    }
    strokes.ctx.drawImage(savedStrokes, 0, 0, width, height);

    // blur trick = shrink it down tiny then stretch it back up
    blurMedium.canvas.width = Math.max(1, Math.round(width / 4));
    blurMedium.canvas.height = Math.max(1, Math.round(height / 4));
    blurSmall.canvas.width = Math.max(1, Math.round(width / 18));
    blurSmall.canvas.height = Math.max(1, Math.round(height / 18));

    // fog grid
    gridCols = Math.ceil(cssWidth / CELL_SIZE);
    gridRows = Math.ceil(cssHeight / CELL_SIZE);
    fogGrid.canvas.width = gridCols;
    fogGrid.canvas.height = gridRows;

    fogDensity = new Float32Array(gridCols * gridRows);
    fogPattern = makeFogPattern(gridCols, gridRows);
    breathShape = makeBreathShape(cssWidth, cssHeight);

    // fog is always white, only the see through-ness changes each frame
    fogImage = fogGrid.ctx.createImageData(gridCols, gridRows);
    for (let i = 0; i < fogImage.data.length; i += 4) {
        fogImage.data[i] = 255;
        fogImage.data[i + 1] = 255;
        fogImage.data[i + 2] = 255;
    }

    // changing the canvas size resets its settings so turn smoothing back on
    for (const layer of [display, fogLayer, fogMask, blurMedium, blurSmall]) {
        layer.ctx.imageSmoothingEnabled = true;
        layer.ctx.imageSmoothingQuality = 'high';
    }
}

// soft circle, strongest in the middle and fades out to the edges
// (like how your breath hits a window)
function makeBreathShape(cssWidth, cssHeight) {
    const shape = new Float32Array(gridCols * gridRows);
    const spread = 0.55 * Math.max(cssWidth, cssHeight);

    for (let y = 0; y < gridRows; y++) {
        for (let x = 0; x < gridCols; x++) {
            const dx = (x + 0.5) * CELL_SIZE - cssWidth / 2;
            const dy = (y + 0.5) * CELL_SIZE - cssHeight / 2;
            const distanceSquared = dx * dx + dy * dy;
            shape[y * gridCols + x] = Math.exp(-distanceSquared / (2 * spread * spread));
        }
    }
    return shape;
}

window.addEventListener('resize', setupSize);
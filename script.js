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
const smoothstep = (t) => t * t * (3 - 2 * t);                          // makes a blend soft instead of sharp
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



// ---------- mic: detecting a blow ----------

// blowing on a mic just sounds like loud whooshy noise
// so checking the volume (RMS) works surprisingly well
function getVolume() {
    analyser.getFloatTimeDomainData(audioSamples);
    let sumOfSquares = 0;
    for (const sample of audioSamples) {
        sumOfSquares += sample * sample;
    }
    return Math.sqrt(sumOfSquares / audioSamples.length);
}

function getBlowStrength() {
    let target = 0;

    if (analyser) {
        const volume = getVolume();
        // higher sensitivity = lower threshold
        const threshold = 0.25 * Math.pow(0.08, settings.micSensitivity);
        target = clamp((volume - threshold) / (threshold * 1.5), 0, 1);
        updateMicMeter(volume, threshold, target > 0);
    }

    if (spaceHeld) target = 1; // backup for testing with the keyboard

    // goes up fast when you start blowing, fades out slower when you stop
    const speed = target > blowStrength ? 0.5 : 0.12;
    blowStrength += (target - blowStrength) * speed;
    return blowStrength;
}

function updateMicMeter(volume, threshold, isBlowing) {
    const meter = document.getElementById('mic-level');
    // the pink line is right in the middle of the meter
    meter.style.width = Math.min(100, (volume / (threshold * 2)) * 100) + '%';
    meter.style.background = isBlowing ? '#e8a6d4' : '#fff';
}


// ---------- fog simulation ----------

// runs every frame
// deltaTime = seconds since the last frame, so it runs the same speed on fast and slow laptops
function updateFog(deltaTime, blow) {
    const fogToAdd = blow * settings.fogSpeed * deltaTime;
    const fogToRemove = settings.clearSpeed * deltaTime;
    let totalFog = 0;

    for (let i = 0; i < fogDensity.length; i++) {
        const shape = breathShape[i];
        const pattern = fogPattern[i];
        let density = fogDensity[i];

        if (fogToAdd > 0) {
            density += fogToAdd
                * (0.35 + 0.65 * shape)    // more fog in the middle
                * (0.55 + 0.45 * pattern)  // patchy
                * (1.05 - density * 0.5);  // slows down when it's already thick
        }

        // edges clear first like real breath on a window
        density -= fogToRemove * (1.6 - shape) * (1.3 - pattern * 0.6);

        density = clamp(density, 0, 1);
        fogDensity[i] = density;
        fogImage.data[i * 4 + 3] = density * 255;
        totalFog += density;
    }

    // blowing again slowly fogs over what you wrote
    // (destination-out = rubber instead of pen)
    if (blow > 0.02) {
        strokes.ctx.globalCompositeOperation = 'destination-out';
        strokes.ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, blow * deltaTime * 2.5)})`;
        strokes.ctx.fillRect(0, 0, width, height);
        strokes.ctx.globalCompositeOperation = 'source-over';
    }

    // once the glass is fully clear, forget the old drawing
    const averageFog = totalFog / fogDensity.length;
    if (averageFog < 0.005) {
        strokes.ctx.clearRect(0, 0, width, height);
    }
}



// ---------- drawing everything ----------

function drawCamera() {
    const { ctx } = display;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    // fill the whole screen without stretching, crops whatever doesn't fit
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;

    // flip it so it acts like a mirror
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    ctx.restore();
}

function drawFogLayer() {
    // blur the cam: shrink it tiny then stretch it back up
    // (ctx.filter = 'blur()' would be easier but not every browser supports it on canvas)
    blurMedium.ctx.drawImage(display.canvas, 0, 0, blurMedium.canvas.width, blurMedium.canvas.height);
    blurSmall.ctx.drawImage(blurMedium.canvas, 0, 0, blurSmall.canvas.width, blurSmall.canvas.height);
    blurMedium.ctx.drawImage(blurSmall.canvas, 0, 0, blurMedium.canvas.width, blurMedium.canvas.height);

    const { ctx } = fogLayer;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(blurMedium.canvas, 0, 0, width, height);

    // milky tint + grain so it looks like steam and not just blurry
    ctx.fillStyle = 'rgba(228, 232, 242, 0.45)';
    ctx.fillRect(0, 0, width, height);
    if (grainPattern) {
        ctx.fillStyle = grainPattern;
        ctx.fillRect(0, 0, width, height);
    }
}

function drawFogMask() {
    // where the fog is = fog grid stretched to full size...
    fogGrid.ctx.putImageData(fogImage, 0, 0);
    fogMask.ctx.clearRect(0, 0, width, height);
    fogMask.ctx.drawImage(fogGrid.canvas, 0, 0, width, height);

    // ...minus everything you've drawn
    fogMask.ctx.globalCompositeOperation = 'destination-out';
    fogMask.ctx.drawImage(strokes.canvas, 0, 0);
    fogMask.ctx.globalCompositeOperation = 'source-over';
}

function render() {
    if (!video.videoWidth) return; // cam isn't ready yet

    drawCamera();
    drawFogLayer();
    drawFogMask();

    // cut the fog into the shape of the mask then put it over the cam
    fogLayer.ctx.globalCompositeOperation = 'destination-in';
    fogLayer.ctx.drawImage(fogMask.canvas, 0, 0);
    fogLayer.ctx.globalCompositeOperation = 'source-over';

    display.ctx.drawImage(fogLayer.canvas, 0, 0);
}


// ---------- drawing with mouse / trackpad / finger ----------

// turns where you clicked into canvas coordinates
function getPoint(event) {
    const rect = display.canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * pixelRatio,
        y: (event.clientY - rect.top) * pixelRatio,
    };
}

function drawStroke(from, to) {
    const { ctx } = strokes;
    ctx.strokeStyle = '#000'; // colour doesn't matter, it's only used to cut out the fog
    ctx.lineWidth = settings.brushSize * pixelRatio;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 5 * pixelRatio; // soft edges like an actual finger
    ctx.shadowColor = '#000';

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y); // +0.01 so just tapping still draws a dot
    ctx.stroke();

    ctx.shadowBlur = 0;
}

// pointer events work for mouse, trackpad, finger AND stylus
display.canvas.addEventListener('pointerdown', (event) => {
    isDrawing = true;
    display.canvas.setPointerCapture(event.pointerId);
    lastPoint = getPoint(event);
    drawStroke(lastPoint, lastPoint);
});

display.canvas.addEventListener('pointermove', (event) => {
    if (!isDrawing) return;

    // coalesced events = the in between points the browser skipped
    // makes fast strokes smooth instead of jaggy
    const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    for (const e of events) {
        const point = getPoint(e);
        drawStroke(lastPoint, point);
        lastPoint = point;
    }
});

function stopDrawing() {
    isDrawing = false;
}
display.canvas.addEventListener('pointerup', stopDrawing);
display.canvas.addEventListener('pointercancel', stopDrawing);


// ---------- controls ----------

const controls = document.getElementById('controls');
const hint = document.getElementById('hint');

document.getElementById('sensitivity-slider').addEventListener('input', (event) => {
    settings.micSensitivity = Number(event.target.value);
});

document.getElementById('brush-slider').addEventListener('input', (event) => {
    settings.brushSize = Number(event.target.value);
});

// slider goes 0 to 1, turned into a clear speed between 0.2 (fast) and 0.01 (slow)
document.getElementById('linger-slider').addEventListener('input', (event) => {
    settings.clearSpeed = 0.2 * Math.pow(0.05, Number(event.target.value));
});

// fog button = fog up the whole screen at once
document.getElementById('fog-button').addEventListener('click', () => {
    for (let i = 0; i < fogDensity.length; i++) {
        fogDensity[i] = 0.75 + 0.25 * fogPattern[i];
    }
    strokes.ctx.clearRect(0, 0, width, height);
});

// clear button = wipe everything
document.getElementById('clear-button').addEventListener('click', () => {
    fogDensity.fill(0);
    strokes.ctx.clearRect(0, 0, width, height);
});

// save button = downloads a png of the screen
document.getElementById('save-button').addEventListener('click', () => {
    display.canvas.toBlob((blob) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'fog-note.png';
        link.click();
        URL.revokeObjectURL(link.href);
    });
});

// hold space = fake blowing, H = hide the controls
window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
        spaceHeld = true;
        event.preventDefault(); // stops space scrolling the page
    }
    if (event.key.toLowerCase() === 'h') {
        controls.classList.toggle('hidden');
        hint.classList.add('hidden');
    }
});

window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') spaceHeld = false;
});


// ---------- hand tracking ----------
// uses google's mediapipe to find your hand in the cam
// point with your index finger to draw, open your hand (or make a fist) to stop

const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// mediapipe gives 21 points on your hand, these are the ones we need
const WRIST = 0;
const INDEX_MIDDLE_JOINT = 6;
const INDEX_TIP = 8;
const MIDDLE_MIDDLE_JOINT = 10;
const MIDDLE_TIP = 12;

let handLandmarker = null;
let lastVideoTime = -1;
let fingertip = null;       // where your index finger is on screen (smoothed)
let fingerIsDrawing = false;
let lastFingerPoint = null;

async function setupHandTracking() {
    try {
        // loads the library from the internet, only when it's needed
        const { FilesetResolver, HandLandmarker } = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
        const vision = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);

        // try the graphics card first (faster), fall back to the normal cpu if it doesn't work
        const makeLandmarker = (delegate) => HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
            runningMode: 'VIDEO',
            numHands: 1,
        });
        try {
            handLandmarker = await makeLandmarker('GPU');
        } catch {
            handLandmarker = await makeLandmarker('CPU');
        }

        hint.textContent = 'hand tracking on ☝️ point to draw, open your hand to stop';
        hint.classList.remove('hidden');
        setTimeout(() => hint.classList.add('hidden'), 5000);
    } catch (error) {
        // no internet or the library didn't load? the mouse + touch still work
        console.warn('hand tracking could not load', error);
    }
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// pointing = index finger straight out, middle finger curled in
// (a finger is "straight" if its tip is further from the wrist than its middle joint)
function isPointing(hand) {
    const wrist = hand[WRIST];
    const indexUp = distance(hand[INDEX_TIP], wrist) > distance(hand[INDEX_MIDDLE_JOINT], wrist);
    const middleDown = distance(hand[MIDDLE_TIP], wrist) < distance(hand[MIDDLE_MIDDLE_JOINT], wrist);
    return indexUp && middleDown;
}

// mediapipe gives positions from 0 to 1 across the video
// this turns that into a spot on the screen, matching how drawCamera() fits + flips the video
function videoToScreen(point) {
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;

    return {
        x: width - (offsetX + point.x * drawWidth), // flipped because the cam is a mirror
        y: offsetY + point.y * drawHeight,
    };
}

function updateHandTracking() {
    // only check when the cam has a new frame (no point checking the same picture twice)
    if (!handLandmarker || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const result = handLandmarker.detectForVideo(video, performance.now());
    const hand = result.landmarks[0];

    // no hand in the picture = stop drawing
    if (!hand) {
        fingertip = null;
        fingerIsDrawing = false;
        lastFingerPoint = null;
        return;
    }

    // smooth it out a bit so the line isn't all wobbly
    const target = videoToScreen(hand[INDEX_TIP]);
    fingertip = fingertip
        ? { x: lerp(fingertip.x, target.x, 0.5), y: lerp(fingertip.y, target.y, 0.5) }
        : target;

    fingerIsDrawing = isPointing(hand);
    if (fingerIsDrawing) {
        drawStroke(lastFingerPoint || fingertip, fingertip);
        lastFingerPoint = fingertip;
    } else {
        lastFingerPoint = null;
    }
}

// little circle where your finger is so you can see where you're aiming
// white = just hovering, pink = drawing
function drawFingertipCursor() {
    if (!fingertip) return;

    const { ctx } = display;
    ctx.beginPath();
    ctx.arc(fingertip.x, fingertip.y, (settings.brushSize / 2) * pixelRatio, 0, Math.PI * 2);
    ctx.strokeStyle = fingerIsDrawing ? '#e8a6d4' : 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2 * pixelRatio;
    ctx.stroke();
}


// ---------- start ----------

async function getCameraAndMic() {
    const videoOptions = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

    try {
        return await navigator.mediaDevices.getUserMedia({
            video: videoOptions,
            // browsers clean up "noise" for video calls by default
            // which would literally filter out the blowing sound we need lol
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
    } catch {
        // no mic? still works with just the cam + spacebar
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoOptions });
        hint.textContent = 'no mic found, hold space to fog · draw to wipe';
        return stream;
    }
}

function setupMicrophone(stream) {
    if (stream.getAudioTracks().length === 0) return;

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser); // NOT connected to the speakers so no feedback
    audioSamples = new Float32Array(analyser.fftSize);
}

async function start() {
    let stream;
    try {
        stream = await getCameraAndMic();
    } catch {
        document.getElementById('error-message').textContent =
            'Could not open the camera. Allow camera access, and open this through Live Server (http://localhost), not as a file.';
        return;
    }

    video.srcObject = stream;
    await video.play();
    setupMicrophone(stream);
    setupHandTracking(); // no await, so the app starts straight away while this loads

    setupSize();
    grainPattern = makeGrainPattern();

    // hide the start screen, show the controls + hint
    document.getElementById('start-screen').remove();
    controls.classList.remove('hidden');
    hint.classList.remove('hidden');
    setTimeout(() => hint.classList.add('hidden'), 6000); // hint disappears after 6 secs

    // main loop: listen -> update fog -> draw, every frame (~60 times a sec)
    let lastTime = performance.now();
    function loop(now) {
        const deltaTime = Math.min(0.05, (now - lastTime) / 1000); // in secs, capped in case the tab lagged
        lastTime = now;

        updateHandTracking();
        updateFog(deltaTime, getBlowStrength());
        render();
        drawFingertipCursor();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

// everything starts when you click the button
document.getElementById('start-button').addEventListener('click', start);
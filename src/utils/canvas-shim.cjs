/**
 * Canvas Shim for Service Worker Environment (CommonJS)
 * 
 * This shim provides a minimal canvas implementation for linkedom's HTMLCanvasElement
 * in environments where the native canvas API is unavailable (e.g., Chrome Extension Service Workers).
 * 
 * The shim implements the essential canvas interface that linkedom expects, preventing
 * the "createCanvas is not a function" error when parsing HTML with canvas elements.
 */

class CanvasRenderingContext2DShim {
  constructor(canvas) {
    this._canvas = canvas;
  }

  get canvas() {
    return this._canvas;
  }

  // Essential 2D context methods (minimal implementation)
  fillRect(x, y, w, h) {
    // No-op in shim
  }

  clearRect(x, y, w, h) {
    // No-op in shim
  }

  strokeRect(x, y, w, h) {
    // No-op in shim
  }

  beginPath() {
    // No-op in shim
  }

  closePath() {
    // No-op in shim
  }

  moveTo(x, y) {
    // No-op in shim
  }

  lineTo(x, y) {
    // No-op in shim
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    // No-op in shim
  }

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    // No-op in shim
  }

  arc(x, y, radius, startAngle, endAngle, anticlockwise) {
    // No-op in shim
  }

  rect(x, y, w, h) {
    // No-op in shim
  }

  fill() {
    // No-op in shim
  }

  stroke() {
    // No-op in shim
  }

  clip() {
    // No-op in shim
  }

  save() {
    // No-op in shim
  }

  restore() {
    // No-op in shim
  }

  translate(x, y) {
    // No-op in shim
  }

  rotate(angle) {
    // No-op in shim
  }

  scale(x, y) {
    // No-op in shim
  }

  transform(a, b, c, d, e, f) {
    // No-op in shim
  }

  setTransform(a, b, c, d, e, f) {
    // No-op in shim
  }

  createImageData(width, height) {
    try {
      return new ImageData(width, height);
    } catch {
      // Fallback for environments without ImageData constructor
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    }
  }

  getImageData(sx, sy, sw, sh) {
    return new ImageData(sw, sh);
  }

  putImageData(imagedata, dx, dy) {
    // No-op in shim
  }

  drawImage(image, dx, dy) {
    // No-op in shim
  }

  // Properties
  get fillStyle() {
    return '#000000';
  }

  set fillStyle(value) {
    // No-op in shim
  }

  get strokeStyle() {
    return '#000000';
  }

  set strokeStyle(value) {
    // No-op in shim
  }

  get lineWidth() {
    return 1;
  }

  set lineWidth(value) {
    // No-op in shim
  }

  get lineCap() {
    return 'butt';
  }

  set lineCap(value) {
    // No-op in shim
  }

  get lineJoin() {
    return 'miter';
  }

  set lineJoin(value) {
    // No-op in shim
  }

  get miterLimit() {
    return 10;
  }

  set miterLimit(value) {
    // No-op in shim
  }

  get shadowBlur() {
    return 0;
  }

  set shadowBlur(value) {
    // No-op in shim
  }

  get shadowColor() {
    return 'rgba(0, 0, 0, 0)';
  }

  set shadowColor(value) {
    // No-op in shim
  }

  get shadowOffsetX() {
    return 0;
  }

  set shadowOffsetX(value) {
    // No-op in shim
  }

  get shadowOffsetY() {
    return 0;
  }

  set shadowOffsetY(value) {
    // No-op in shim
  }

  get globalAlpha() {
    return 1.0;
  }

  set globalAlpha(value) {
    // No-op in shim
  }

  get globalCompositeOperation() {
    return 'source-over';
  }

  set globalCompositeOperation(value) {
    // No-op in shim
  }

  get font() {
    return '10px sans-serif';
  }

  set font(value) {
    // No-op in shim
  }

  get textAlign() {
    return 'start';
  }

  set textAlign(value) {
    // No-op in shim
  }

  get textBaseline() {
    return 'alphabetic';
  }

  set textBaseline(value) {
    // No-op in shim
  }
}

class CanvasShim {
  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
    this._context = null;
  }

  getContext(contextType) {
    if (contextType === '2d') {
      if (!this._context) {
        this._context = new CanvasRenderingContext2DShim(this);
      }
      return this._context;
    }
    return null;
  }

  toDataURL(type, quality) {
    // Return a minimal data URL representation
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }

  toBlob(callback, type, quality) {
    // Return a minimal blob
    const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    callback(new Blob([data], { type: type || 'image/png' }));
  }
}

/**
 * Creates a canvas element with the specified dimensions.
 * This is the function that linkedom's HTMLCanvasElement expects to be available.
 */
function createCanvas(width = 300, height = 150) {
  return new CanvasShim(width, height);
}

/**
 * Export the canvas class for direct usage if needed
 */
module.exports = {
  createCanvas,
  Canvas: CanvasShim,
};

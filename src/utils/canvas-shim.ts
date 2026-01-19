/**
 * Canvas Shim for Service Worker Environment
 * 
 * This shim provides a minimal canvas implementation for linkedom's HTMLCanvasElement
 * in environments where the native canvas API is unavailable (e.g., Chrome Extension Service Workers).
 * 
 * The shim implements the essential canvas interface that linkedom expects, preventing
 * the "createCanvas is not a function" error when parsing HTML with canvas elements.
 */

class CanvasRenderingContext2DShim {
  private _canvas: CanvasShim;

  constructor(canvas: CanvasShim) {
    this._canvas = canvas;
  }

  get canvas() {
    return this._canvas;
  }

  // Essential 2D context methods (minimal implementation)
  fillRect(x: number, y: number, w: number, h: number): void {
    // No-op in shim
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    // No-op in shim
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    // No-op in shim
  }

  beginPath(): void {
    // No-op in shim
  }

  closePath(): void {
    // No-op in shim
  }

  moveTo(x: number, y: number): void {
    // No-op in shim
  }

  lineTo(x: number, y: number): void {
    // No-op in shim
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    // No-op in shim
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    // No-op in shim
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void {
    // No-op in shim
  }

  rect(x: number, y: number, w: number, h: number): void {
    // No-op in shim
  }

  fill(): void {
    // No-op in shim
  }

  stroke(): void {
    // No-op in shim
  }

  clip(): void {
    // No-op in shim
  }

  save(): void {
    // No-op in shim
  }

  restore(): void {
    // No-op in shim
  }

  translate(x: number, y: number): void {
    // No-op in shim
  }

  rotate(angle: number): void {
    // No-op in shim
  }

  scale(x: number, y: number): void {
    // No-op in shim
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // No-op in shim
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // No-op in shim
  }

  createImageData(width: number, height: number): ImageData {
    try {
      return new ImageData(width, height);
    } catch {
      // Fallback for environments without ImageData constructor
      return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    return new ImageData(sw, sh);
  }

  putImageData(imagedata: ImageData, dx: number, dy: number): void {
    // No-op in shim
  }

  drawImage(image: any, dx: number, dy: number): void {
    // No-op in shim
  }

  // Properties
  get fillStyle(): string {
    return '#000000';
  }

  set fillStyle(value: string) {
    // No-op in shim
  }

  get strokeStyle(): string {
    return '#000000';
  }

  set strokeStyle(value: string) {
    // No-op in shim
  }

  get lineWidth(): number {
    return 1;
  }

  set lineWidth(value: number) {
    // No-op in shim
  }

  get lineCap(): string {
    return 'butt';
  }

  set lineCap(value: string) {
    // No-op in shim
  }

  get lineJoin(): string {
    return 'miter';
  }

  set lineJoin(value: string) {
    // No-op in shim
  }

  get miterLimit(): number {
    return 10;
  }

  set miterLimit(value: number) {
    // No-op in shim
  }

  get shadowBlur(): number {
    return 0;
  }

  set shadowBlur(value: number) {
    // No-op in shim
  }

  get shadowColor(): string {
    return 'rgba(0, 0, 0, 0)';
  }

  set shadowColor(value: string) {
    // No-op in shim
  }

  get shadowOffsetX(): number {
    return 0;
  }

  set shadowOffsetX(value: number) {
    // No-op in shim
  }

  get shadowOffsetY(): number {
    return 0;
  }

  set shadowOffsetY(value: number) {
    // No-op in shim
  }

  get globalAlpha(): number {
    return 1.0;
  }

  set globalAlpha(value: number) {
    // No-op in shim
  }

  get globalCompositeOperation(): string {
    return 'source-over';
  }

  set globalCompositeOperation(value: string) {
    // No-op in shim
  }

  get font(): string {
    return '10px sans-serif';
  }

  set font(value: string) {
    // No-op in shim
  }

  get textAlign(): string {
    return 'start';
  }

  set textAlign(value: string) {
    // No-op in shim
  }

  get textBaseline(): string {
    return 'alphabetic';
  }

  set textBaseline(value: string) {
    // No-op in shim
  }
}

class CanvasShim {
  public width: number;
  public height: number;
  private _context: CanvasRenderingContext2DShim | null = null;

  constructor(width: number = 300, height: number = 150) {
    this.width = width;
    this.height = height;
  }

  getContext(contextType: string): CanvasRenderingContext2DShim | null {
    if (contextType === '2d') {
      if (!this._context) {
        this._context = new CanvasRenderingContext2DShim(this);
      }
      return this._context;
    }
    return null;
  }

  toDataURL(type?: string, quality?: number): string {
    // Return a minimal data URL representation
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }

  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void {
    // Return a minimal blob
    const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    callback(new Blob([data], { type: type || 'image/png' }));
  }
}

/**
 * Creates a canvas element with the specified dimensions.
 * This is the function that linkedom's HTMLCanvasElement expects to be available.
 */
export function createCanvas(width: number = 300, height: number = 150): CanvasShim {
  return new CanvasShim(width, height);
}

/**
 * Export the canvas class for direct usage if needed
 */
export { CanvasShim as Canvas };

/**
 * Default export for compatibility with linkedom's canvas module
 */
export default {
  createCanvas,
  Canvas: CanvasShim,
};

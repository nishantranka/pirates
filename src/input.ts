export class Input {
  private down = new Set<string>();
  private justPressed = new Set<string>();
  private virtual = { left: false, right: false, fire: false, dive: false };

  constructor() {
    window.addEventListener('keydown', (e) => {
      // Don't capture (or block) keys while the user types in a form field.
      if (e.target instanceof HTMLInputElement) return;
      this.down.add(e.code);
      if (!e.repeat) this.justPressed.add(e.code);
      // Keep Space/arrows from scrolling the page.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  /** Set on-screen touch button state (called by the canvas touch handlers). */
  setVirtual(left: boolean, right: boolean, fire: boolean, dive = false) {
    this.virtual.left = left;
    this.virtual.right = right;
    this.virtual.fire = fire;
    this.virtual.dive = dive;
  }

  isDown(code: string): boolean {
    if (code === 'ArrowLeft' || code === 'KeyA') return this.down.has(code) || this.virtual.left;
    if (code === 'ArrowRight' || code === 'KeyD') return this.down.has(code) || this.virtual.right;
    if (code === 'Space') return this.down.has(code) || this.virtual.fire;
    if (code === 'ArrowDown' || code === 'KeyS') return this.down.has(code) || this.virtual.dive;
    return this.down.has(code);
  }

  /** True only on the frame the key went down (until clearPressed). */
  wasPressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  /** Call at the end of each update so presses are edge-triggered. */
  clearPressed() {
    this.justPressed.clear();
  }
}
